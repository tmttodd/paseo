import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { DshWire } from "./wire.js";

/**
 * One owned `dsh web` host, loopback only.
 *
 * The provider does not attach to a host someone else runs: it starts the host
 * it drives, on a free loopback port, with `--no-open`, and reads the
 * `dsh web:` line the host prints when it is ready. The launch token from that
 * line is exchanged once for the signed cookie the API and the stream socket
 * require, and never leaves this process.
 */

export interface HostOptions {
  /** The launcher command from the provider registration, e.g. `["dsh"]`. */
  command: readonly string[];
  /** Environment for the host process (the daemon's launch env). */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** DSH profile to boot; `web` is the only shipped HTTP surface. */
  profile?: string;
  /** Extra patch-list overlays, applied after the profile layer. */
  patches?: readonly string[];
  /** How long to wait for the ready line, in milliseconds. */
  timeoutMs?: number;
}

export class HostStartError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "HostStartError";
    this.stderr = stderr;
  }
}

const READY_LINE = /dsh web:\s+(\S+)/u;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const EXIT_GRACE_MS = 5_000;
/** Keep only the tail: a profile that fails to boot can log for a long time. */
const STDERR_TAIL_CHARS = 8_000;

export class DshHost {
  readonly wire: DshWire;
  readonly port: number;
  private readonly child: ChildProcess;
  private exited = false;
  private readonly exitListeners = new Set<(code: number | null) => void>();

  constructor(child: ChildProcess, port: number, cookie: string) {
    this.child = child;
    this.port = port;
    this.wire = new DshWire(`http://127.0.0.1:${String(port)}`);
    this.wire.setCookie(cookie);
    this.wire.start();
    child.once("exit", (code) => {
      this.exited = true;
      for (const listener of this.exitListeners) {
        try {
          listener(code);
        } catch {
          // A listener that throws is not the host's problem.
        }
      }
      this.exitListeners.clear();
    });
  }

  static async start(options: HostOptions): Promise<DshHost> {
    const profile = options.profile ?? "web";
    let lastError: HostStartError | undefined;
    // A port we just probed can still be taken in the gap before the host binds;
    // one retry turns that race into a hiccup instead of a dead provider.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const port = await freePort();
      try {
        return await startOnce(options, profile, port);
      } catch (error) {
        if (!(error instanceof HostStartError)) throw error;
        lastError = error;
        if (!/EADDRINUSE/u.test(error.stderr)) throw error;
      }
    }
    throw lastError ?? new HostStartError("dsh web did not start", "");
  }

  get alive(): boolean {
    return !this.exited;
  }

  onExit(listener: (code: number | null) => void): () => void {
    if (this.exited) {
      queueMicrotask(() => {
        listener(null);
      });
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** Stop the host: SIGTERM, then SIGKILL if it outlives the grace period. */
  async close(): Promise<void> {
    this.wire.stop();
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => {
        resolve();
      });
    });
    void terminateProcess(this.child, "SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(true);
        }, EXIT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timedOut) {
      await terminateProcess(this.child, "SIGKILL");
      await exited;
    }
  }
}

async function startOnce(options: HostOptions, profile: string, port: number): Promise<DshHost> {
  const [binary, ...leading] = options.command;
  if (binary === undefined || binary === "") {
    throw new HostStartError("the provider has no launcher command", "");
  }
  const patches = (options.patches ?? []).flatMap((patch) => ["--patch", patch]);
  // Launcher flags before the app's own: `dsh <profile> --patch …` is read by
  // the app and rejected (`unknown option '--patch'`), so name the profile.
  const args = [
    ...leading,
    "--profile",
    profile,
    ...patches,
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  const child = spawnProcess(binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let settled = false;
  const ready = new Promise<{ cookie: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new HostStartError(
          `dsh web did not print its ready line within ${String(options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS)}ms`,
          stderr,
        ),
      );
    }, options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    timer.unref?.();

    const onChunk = (chunk: Buffer, channel: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");
      if (channel === "stderr") {
        stderr = (stderr + text).slice(-STDERR_TAIL_CHARS);
      }
      const match = READY_LINE.exec(text);
      if (match?.[1] === undefined || settled) return;
      settled = true;
      clearTimeout(timer);
      const token = tokenOf(match[1]);
      if (token === undefined) {
        reject(new HostStartError("dsh printed a ready line without a launch token", stderr));
        return;
      }
      void (async () => {
        try {
          const cookie = await exchangeToken(port, token);
          resolve({ cookie });
        } catch (error) {
          reject(
            new HostStartError(
              `dsh refused the launch token: ${error instanceof Error ? error.message : String(error)}`,
              stderr,
            ),
          );
        }
      })();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      onChunk(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      onChunk(chunk, "stderr");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HostStartError(`could not start dsh web: ${error.message}`, stderr));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new HostStartError(`dsh web exited before it was ready (code ${String(code)})`, stderr),
      );
    });
  });
  try {
    const { cookie } = await ready;
    return new DshHost(child, port, cookie);
  } catch (error) {
    void terminateProcess(child, "SIGTERM");
    throw error;
  }
}

function tokenOf(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get("token");
    return token === null || token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * The launch handshake: `GET /?token=` answers 303 with the signed cookie. The
 * cookie is bound to the authority it was asked for, so the exchange always
 * goes to the loopback address we bound, never to an advertised public URL.
 */
async function exchangeToken(port: number, token: string): Promise<string> {
  const url = new URL(`http://127.0.0.1:${String(port)}/`);
  url.searchParams.set("token", token);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
  if (response.status !== 303) {
    throw new Error(
      `HTTP ${String(response.status)} — the launch token changes every time dsh restarts`,
    );
  }
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0]?.trim() ?? "")
    .find((pair) => pair.startsWith("dsh-auth-"));
  if (cookie === undefined) throw new Error("dsh accepted the token but sent no cookie");
  return cookie;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
