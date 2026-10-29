import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type { Json } from "./internal/timeline.js";
import {
  catalogFromHost,
  modesFromPresets,
  presetsFromHost,
  type CatalogValue,
  type PresetEntry,
} from "./internal/catalog.js";
import { DshHost } from "./internal/host.js";
import { Session } from "./internal/session.js";
import { DshError, type DshResult, type DshWire, type StreamHandle } from "./internal/wire.js";

/**
 * DSH's native provider: one owned `dsh web` host, driven over the same wire the
 * browser uses. The one-shot `dsh-provider` cannot carry DSH's command plane;
 * this one can, so `/goal` and `/plan` are the host's own commands.
 */

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  // Host questions (ask_user_question, exit_plan_mode) surface as permission
  // cards, so the daemon may send the answer back.
  "permission",
  // The host's prompt accepts image content parts and its own limit report
  // governs them; `encodeContent` maps Paseo images to DSH image blocks.
  "prompt.image",
  "session.configure",
  "session.persistence",
] as const;

/**
 * Rows a Paseo-owned host must not run: they dial out or expose a control plane
 * that belongs to the user's own surfaces, not to a headless child. Only rows
 * present in the profile are disabled (a patch naming a missing row is an error).
 */
const OUTWARD_ROWS = [
  "bridle-plugin",
  "remote-config",
  "dsh-remote-config",
  "plugin-market",
  "plugin-market-index",
];

interface DshWebOptions {
  /** DSH profile to boot. Default `web` (the only shipped HTTP surface). */
  profile?: string;
  /** Extra patch-list overlay applied after the profile layer. */
  patch?: string;
  /** Disable outward-facing rows the profile mounts. Default true. */
  isolate?: boolean;
}

export function createDshWebProvider(): ProviderRegistration {
  return {
    id: "dsh-web",
    label: "DSH (native)",
    icon: "icon.svg",
    command: ["dsh"],
    description:
      "DeepSeek Harness over a local dsh web host — native /goal, /plan and the host's command list",
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic:
            "dsh not found on PATH. Install the DeepSeek Harness CLI, then run `dsh --version`.",
        };
      }
      try {
        await runVersion(launch);
        return { available: true };
      } catch (error) {
        return {
          available: false,
          diagnostic: `dsh did not answer --version: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new DshError("Provider protocol version 1 is required", "UNSUPPORTED_PROTOCOL");
      }
      if (!request.launch) throw new DshError("The daemon must supply the DSH launch", "NO_LAUNCH");
      const negotiated = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createConnection(request.launch, negotiated);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  let host: DshHost | undefined;
  let hostProfile: string | undefined;
  let patchDirectory: string | undefined;
  let catalog: CatalogValue | null = null;
  let pending = Promise.resolve();
  let eventsStream: StreamHandle | undefined;
  let eventsClientId: string | undefined;
  let eventsBlocked = false;
  const eventSessions = new Map<string, Session>();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  async function isolationPatch(
    options: DshWebOptions,
    profile: string,
  ): Promise<string | undefined> {
    if (options.patch !== undefined) return options.patch;
    if (options.isolate === false) return undefined;
    const home = launch.env.DSH_HOME ?? join(homedir(), ".dsh");
    let text: string;
    try {
      text = await readFile(join(home, "profiles", profile, "cordis.patch.yml"), "utf8");
    } catch {
      return undefined;
    }
    const rows = OUTWARD_ROWS.filter((id) =>
      new RegExp(`(?:^|\\s)id:\\s*['"]?${id}['"]?\\s*$`, "mu").test(text),
    );
    if (rows.length === 0) return undefined;
    patchDirectory = await mkdtemp(join(tmpdir(), "paseo-dsh-web-"));
    const file = join(patchDirectory, "isolate.yml");
    await writeFile(file, rows.map((id) => `- id: ${id}\n  disabled: true\n`).join(""), "utf8");
    return file;
  }

  let hostStart: Promise<DshHost> | undefined;

  /** Single-flight: the eager warm and the first request must share one boot. */
  function ensureHost(options: DshWebOptions): Promise<DshHost> {
    hostStart ??= ensureHostOnce(options).finally(() => {
      hostStart = undefined;
    });
    return hostStart;
  }

  async function ensureHostOnce(options: DshWebOptions): Promise<DshHost> {
    const profile = options.profile ?? "web";
    if (host !== undefined) {
      if (hostProfile !== profile && sessions.size > 0) {
        throw new DshError(
          `This connection already runs the DSH host with profile ${JSON.stringify(hostProfile)}; ` +
            `changing to ${JSON.stringify(profile)} needs a new agent connection`,
          "PROFILE_LOCKED",
        );
      }
      if (hostProfile === profile && host.alive) return host;
      await host.close();
      host = undefined;
    }
    const patch = await isolationPatch(options, profile);
    const started = await DshHost.start({
      command: [launch.command, ...launch.args],
      env: launch.env,
      profile,
      patches: patch === undefined ? [] : [patch],
    });
    if (closed) {
      // The connection closed while the host was booting: do not leak the child.
      await started.close();
      throw new DshError("DSH connection is closed", "CONNECTION_CLOSED");
    }
    host = started;
    hostProfile = profile;
    openEvents(started);
    started.onExit(() => {
      if (host !== started) return;
      host = undefined;
      catalog = null;
      for (const session of sessions.values()) {
        session.hostFailed("The dsh web host exited");
      }
      sessions.clear();
    });
    return started;
  }

  /** The host's human-interaction channel: questions, plan review, approvals. */
  function openEvents(target: DshHost): void {
    if (closed || eventsBlocked || eventsStream !== undefined) return;
    eventsClientId = undefined;
    eventsStream = target.wire.open(
      "$events",
      {},
      {
        item: (value) => acceptEventFrame(value),
        end: () => {
          eventsStream = undefined;
          reopenEventsWhenConnected(target);
        },
        error: (error) => {
          eventsStream = undefined;
          // A peer without the answer interaction can never use this stream; a
          // reopen would just loop. The provider degrades to notices-only.
          if (error.code === "gateway/interactions-forbidden") {
            eventsBlocked = true;
            return;
          }
          reopenEventsWhenConnected(target);
        },
      },
    );
  }

  function reopenEventsWhenConnected(target: DshHost): void {
    if (closed) return;
    const stop = target.wire.onConnection((state) => {
      if (!state.connected) return;
      stop();
      openEvents(target);
    });
    if (target.wire.connection.connected) {
      stop();
      setTimeout(() => openEvents(target), 250).unref?.();
    }
  }

  function acceptEventFrame(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const frame = value as {
      type?: unknown;
      clientId?: unknown;
      event?: unknown;
      eventId?: unknown;
      agentId?: unknown;
      request?: unknown;
    };
    if (frame.type === "ready") {
      if (typeof frame.clientId === "string") eventsClientId = frame.clientId;
      return;
    }
    if (frame.type === "waterfall") {
      const eventId = typeof frame.eventId === "string" ? frame.eventId : undefined;
      const agentId = typeof frame.agentId === "string" ? frame.agentId : undefined;
      const event = typeof frame.event === "string" ? frame.event : undefined;
      if (eventId === undefined || agentId === undefined || event === undefined) return;
      const session = [...sessions.values()].find((entry) => entry.dshSessionId === agentId);
      if (session === undefined) return;
      eventSessions.set(eventId, session);
      session.acceptWaterfall(event, eventId, (frame.request ?? {}) as Record<string, unknown>);
      return;
    }
    if (frame.type === "cancel") {
      const eventId = typeof frame.eventId === "string" ? frame.eventId : undefined;
      if (eventId === undefined) return;
      eventSessions.get(eventId)?.onWaterfallCancel(eventId);
      eventSessions.delete(eventId);
    }
  }

  async function answerWaterfall(eventId: string, outcome: Json): Promise<DshResult> {
    if (host === undefined) {
      return {
        ok: false,
        error: { code: "HOST_GONE", message: "The dsh web host is not running", details: {} },
      };
    }
    if (eventsClientId === undefined) {
      return {
        ok: false,
        error: {
          code: "EVENTS_NOT_READY",
          message: "The dsh event stream has not delivered its client id",
          details: {},
        },
      };
    }
    eventSessions.delete(eventId);
    // `call` wraps its argument object in the payload's `args`, so the result
    // method takes the three fields directly (a nested `args` would be rejected).
    return host.wire.call("$events/result", { clientId: eventsClientId, eventId, outcome });
  }

  async function loadCatalog(target: DshHost): Promise<CatalogValue | null> {
    if (catalog !== null) return catalog;
    const result = await target.wire.call("session/modelCatalog", {});
    if (!result.ok) return null;
    const value = catalogFromHost(result.value);
    if (value === null) return null;
    // The agent presets are the provider's modes, and the create screen reads
    // them from this catalog — not only from a session's config.
    const presets = await presetsOfHost(target.wire);
    if (presets.length > 0) {
      const { modes, mode } = modesFromPresets(presets, undefined);
      value.catalog = {
        ...value.catalog,
        modes,
        ...(mode === undefined ? {} : { defaultMode: mode }),
      };
    }
    catalog = value;
    return catalog;
  }

  async function presetsOfHost(wire: DshWire): Promise<PresetEntry[]> {
    const result = await wire.call("agentPresets/list", {});
    return result.ok ? presetsFromHost(result.value) : [];
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        const started = await ensureHost({});
        const value = await loadCatalog(started);
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: value?.catalog ?? emptyCatalog(),
        });
        return;
      }
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new DshError(`Session already exists: ${input.sessionId}`, "SESSION_EXISTS");
        }
        const options = optionsOf(input.config);
        const started = await ensureHost(options);
        const value = await loadCatalog(started);
        const session = new Session({
          id: input.sessionId,
          config: input.config,
          wire: started.wire,
          capabilities: negotiated,
          catalog: () => value,
          emit,
          answerWaterfall,
          onClosed: () => {
            sessions.delete(input.sessionId);
          },
        });
        sessions.set(input.sessionId, session);
        try {
          await session.open(input.requestId, input.persistence, input.history);
        } catch (error) {
          sessions.delete(input.sessionId);
          await session.close().catch(() => {});
          throw error;
        }
        return;
      }
      case "session.prompt":
        await sessionOf(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        await sessionOf(input.sessionId).configure(input.changes);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.permission":
        await sessionOf(input.sessionId).answerPermission(input.permissionId, input.response);
        return;
      case "session.interrupt":
        await sessionOf(input.sessionId).interrupt();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close": {
        const session = sessions.get(input.sessionId);
        if (session !== undefined) await session.close();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        throw new DshError(`Unsupported DSH operation: ${input.type}`, "UNSUPPORTED_OPERATION");
    }
  }

  // The create screen reads models from the provider snapshot, which warms
  // lazily per workspace. Booting the host now means the first snapshot for a
  // new workspace finds the catalog cached instead of showing a model-less
  // provider while a host boots.
  void (async () => {
    try {
      const started = await ensureHost({});
      await loadCatalog(started);
    } catch {
      // The lazy path retries on the next catalog request.
    }
  })();

  function sessionOf(id: string): Session {
    const found = sessions.get(id);
    if (found === undefined) throw new DshError(`Unknown DSH session: ${id}`, "UNKNOWN_SESSION");
    return found;
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new DshError("DSH connection is closed", "CONNECTION_CLOSED");
      requireProviderCapabilities(negotiated, input);
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error: unknown) => {
          const failure = asError(error);
          if (input.type === "session.prompt") {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: failure },
            });
          } else if ("requestId" in input) {
            emit({ type: "request.failed", requestId: input.requestId, error: failure });
          }
        });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending.catch(() => {});
      await Promise.all([...sessions.values()].map((session) => session.close().catch(() => {})));
      sessions.clear();
      listeners.clear();
      await host?.close().catch(() => {});
      host = undefined;
      if (patchDirectory !== undefined)
        await rm(patchDirectory, { recursive: true, force: true }).catch(() => {});
      patchDirectory = undefined;
    },
  };
}

function optionsOf(config: ProviderSessionConfig): DshWebOptions {
  const raw = config.providerOptions;
  if (raw === undefined || typeof raw !== "object" || raw === null) return {};
  const value = raw as Record<string, unknown>;
  return {
    ...(typeof value.profile === "string" && value.profile !== ""
      ? { profile: value.profile }
      : {}),
    ...(typeof value.patch === "string" && value.patch !== "" ? { patch: value.patch } : {}),
    ...(typeof value.isolate === "boolean" ? { isolate: value.isolate } : {}),
  };
}

function emptyCatalog(): ProviderCatalog {
  return { models: [], modes: [], thinkingOptions: [] };
}

function asError(error: unknown): { message: string; code?: string } {
  if (error instanceof DshError) return { message: error.message, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

async function runVersion(launch: ProviderLaunch): Promise<void> {
  await execCommand(launch.command, [...launch.args, "--version"], {
    env: launch.env,
    timeout: 10_000,
  });
}
