import { createHash } from "node:crypto";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { DEFAULT_PROFILE, getCatalog, getStatus, profileOf } from "./internal/catalog.js";
import { Session } from "./internal/session.js";
import { DshError } from "./internal/wire.js";

/**
 * DSH's headless CLI has no MCP flags and no permission channel, so the provider
 * advertises neither `supportsMcpServers` nor the permission capabilities.
 */
const capabilities = ["prompt.message", "session.configure", "session.persistence"] as const;

export function createDshProvider(): ProviderRegistration {
  return {
    id: "dsh",
    label: "DSH",
    icon: "icon.svg",
    command: ["dsh"],
    description: "DeepSeek Harness (dsh) on your host",
    async status({ launch }) {
      if (!launch)
        return {
          available: false,
          diagnostic:
            "dsh not found on PATH. Install the DeepSeek Harness CLI, then run `dsh --version`.",
        };
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new DshError("Provider protocol version 1 is required", "UNSUPPORTED_PROTOCOL");
      if (!request.launch) throw new DshError("The daemon must supply the DSH launch", "NO_LAUNCH");
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
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
  const catalogs = new Map<string, ProviderCatalog>();
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }
  function session(id: string): Session {
    const found = sessions.get(id);
    if (!found) throw new DshError(`Unknown DSH session: ${id}`, "UNKNOWN_SESSION");
    return found;
  }
  /** The model list comes from the profile's composed config, so cache per profile. */
  async function catalogFor(profile: string, cwd?: string): Promise<ProviderCatalog> {
    const cached = catalogs.get(profile);
    if (cached) return cached;
    const discovered = await getCatalog(launch, { profile, cwd });
    catalogs.set(profile, discovered);
    return discovered;
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await catalogFor(DEFAULT_PROFILE, input.cwd),
        });
        return;
      }
      case "session.open": {
        if (sessions.has(input.sessionId))
          throw new DshError(`Session already exists: ${input.sessionId}`, "SESSION_EXISTS");
        const profile = profileOf(input.config);
        const catalog = await catalogFor(profile, input.config.cwd);
        const opened = new Session({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          catalog: () => catalog,
          launch,
          emit,
        });
        sessions.set(input.sessionId, opened);
        try {
          await opened.open(input.requestId, negotiated);
        } catch (error) {
          sessions.delete(input.sessionId);
          await opened.close();
          throw error;
        }
        return;
      }
      case "session.prompt":
        await session(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        await session(input.sessionId).configure(input.changes);
        break;
      case "session.interrupt":
        await session(input.sessionId).interrupt();
        break;
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new DshError(`Unsupported DSH operation: ${input.type}`, "UNSUPPORTED_OPERATION");
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DshError ? error.code : "DSH_ERROR";
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
    else if ("requestId" in input)
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
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
        .catch((error) => failed(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      listeners.clear();
    },
  };
}
