import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { DshError, decodeEvent, diagnostic, type DshEvent } from "./wire.js";

const STDERR_LIMIT = 8192;
const TERMINATE_GRACE_MS = 2000;
const PROBE_TIMEOUT_MS = 20_000;

export interface TurnArgsOptions {
  profile: string;
  /** Patch overlays in application order: the caller's overlay, then the session's own. */
  patchPaths?: readonly string[];
  /** Native DSH session id; present when resuming. */
  sessionId?: string | null;
  /** Final argv element: the whole turn prompt. */
  taskText: string;
}

/**
 * DSH takes exactly one turn per process:
 *   dsh --profile <profile> [--patch <file>] --json [--session-id <id>] <task>
 *
 * Launcher flags must precede the app flags. `dsh` stops parsing its own options at the
 * first argument it does not recognise, so `--json --patch <file>` is handed to the
 * headless app, which answers `{"type":"error","message":"unknown option '--patch'"}`
 * and exits 1. Verified against dsh 0.2.1-rc.3.
 */
export function turnArgs(options: TurnArgsOptions): string[] {
  const args = ["--profile", options.profile];
  for (const patchPath of options.patchPaths ?? []) args.push("--patch", patchPath);
  args.push("--json");
  if (options.sessionId) args.push("--session-id", options.sessionId);
  args.push(options.taskText);
  return args;
}

export interface TurnExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface TurnProcessOptions {
  launch: ProviderLaunch;
  config: Pick<ProviderSessionConfig, "cwd" | "env">;
  args: string[];
  onEvent(event: DshEvent): void;
  /** The stream broke; the turn cannot continue. */
  onProtocolError(error: DshError): void;
  /** Called exactly once, after stdout is drained. */
  onExit(exit: TurnExit): void;
}

export interface TurnProcess {
  readonly done: Promise<TurnExit>;
  /** SIGTERM, then SIGKILL after a grace period. Resolves once the child is gone. */
  interrupt(): Promise<void>;
}

export function startTurn(options: TurnProcessOptions): TurnProcess {
  const child = spawnProcess(options.launch.command, [...options.launch.args, ...options.args], {
    cwd: options.config.cwd,
    env: { ...options.launch.env, ...options.config.env },
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  let exited = false;
  let protocolError: DshError | null = null;
  const { promise: completed, resolve: settle } = Promise.withResolvers<TurnExit>();

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
  });
  // DSH reads its turn from argv; keep stdin closed so a stray read cannot block the turn.
  child.stdin.end();
  child.on("error", (error: Error) => {
    if (exited) return;
    // Only the first failure describes the turn; later noise is a consequence of it.
    if (protocolError === null) {
      protocolError = new DshError(diagnostic(error.message), "SPAWN_ERROR");
      options.onProtocolError(protocolError);
    }
    // A spawn failure reports `error` and may never report `close`; do not hang the turn.
    if (child.pid === undefined) finish({ code: null, signal: null, stderr: stderr.trim() });
  });
  lines.on("line", (line) => {
    if (exited) return;
    let event: DshEvent | null;
    try {
      event = decodeEvent(line);
    } catch (error) {
      const failure =
        error instanceof DshError
          ? error
          : new DshError(error instanceof Error ? error.message : String(error), "INVALID_STREAM");
      if (protocolError === null) {
        protocolError = failure;
        options.onProtocolError(failure);
      }
      return;
    }
    if (event !== null) options.onEvent(event);
  });
  function finish(exit: TurnExit): void {
    if (exited) return;
    exited = true;
    lines.close();
    options.onExit(exit);
    settle(exit);
  }
  child.on("close", (code, exitSignal) =>
    finish({ code, signal: exitSignal, stderr: stderr.trim() }),
  );

  return {
    done: completed,
    async interrupt() {
      if (exited) return;
      await stop(child, completed);
    },
  };
}

async function stop(child: ChildProcessWithoutNullStreams, done: Promise<TurnExit>): Promise<void> {
  signal(child, "SIGTERM");
  const escalate = setTimeout(() => signal(child, "SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await done;
  } finally {
    clearTimeout(escalate);
    // A tool child can outlive the DSH leader that owned it.
    signal(child, "SIGKILL");
  }
}

/** Signal the whole process group on POSIX; taskkill the tree on Windows. */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (process.platform === "win32") {
    void terminateProcess(child, name).catch(() => undefined);
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, name);
  } catch (error) {
    // ESRCH means the group is already gone; anything else is worth surfacing.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    child.kill(name);
  }
}

export interface ProbeOptions {
  launch: ProviderLaunch;
  args: string[];
  cwd?: string;
}

/** Run a short-lived informational DSH command and return stdout. */
export async function probe(options: ProbeOptions): Promise<string> {
  try {
    const { stdout } = await execCommand(
      options.launch.command,
      [...options.launch.args, ...options.args],
      {
        cwd: options.cwd,
        env: { ...options.launch.env },
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DshError(diagnostic(message), "PROBE_FAILED");
  }
}
