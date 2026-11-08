import { describe, expect, test, vi } from "vitest";

import {
  createRecordingLogger,
  createSessionForTest,
  createStoredAgentRecord,
  type SessionForTestOptions,
} from "./session.test-harness.js";
import type { SessionInboundMessage } from "./messages.js";
import { RequestOutcomeError } from "./request-outcome.js";

interface HandlerOutcomeCase {
  name: string;
  message: SessionInboundMessage;
  requestType?: string;
  /** The handler's own log message, so the error half proves which seam failed. */
  handlerMessage: string;
  overrides: (failure: Error) => Partial<SessionForTestOptions>;
}

// ensureAgentLoaded reads the record, then asks the manager for its providers: failing there reaches
// the handler's catch without needing a live agent.
function loadFailureStub(failure: Error, agentId: string): Partial<SessionForTestOptions> {
  return {
    agentStorage: {
      get: vi.fn().mockResolvedValue(createStoredAgentRecord({ id: agentId, cwd: "/tmp/agent" })),
    },
    agentManager: {
      getAgent: vi.fn(() => undefined),
      getRegisteredProviderIds: vi.fn(() => {
        throw failure;
      }),
      waitForAgentClose: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function agentStub(failure: Error, method: string): Partial<SessionForTestOptions> {
  return {
    agentManager: {
      getAgent: vi.fn(() => undefined),
      // ensureAgentLoaded awaits this while unwinding a failed load.
      waitForAgentClose: vi.fn().mockResolvedValue(undefined),
      [method]: vi.fn().mockRejectedValue(failure),
    },
  };
}

// Only the intended method rejects: a stub that rejected get/list/update/archive alike would let
// the row pass after the handler's first call drifted to another workspace method.
function workspaceStub(failure: Error): Partial<SessionForTestOptions> {
  return { workspaceRegistry: { get: vi.fn().mockRejectedValue(failure) } };
}

const DELETE_AGENT_ID = "agent-delete";

// The three ensureAgentLoaded rows fail at the provider lookup, so they prove the handler's catch
// branches by class; they do not exercise the handler's own primary call (clearAgentAttention,
// fetchTimeline), which needs a live agent to reach.
const handlerOutcomeCases: HandlerOutcomeCase[] = [
  {
    name: "delete_agent_request",
    handlerMessage: `Failed to fully delete agent ${DELETE_AGENT_ID}`,
    message: { type: "delete_agent_request", agentId: DELETE_AGENT_ID, requestId: "req-delete" },
    overrides: (failure) => ({
      agentStorage: {
        get: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockRejectedValue(failure),
      },
      agentManager: {
        getAgent: vi.fn(() => undefined),
        closeAgent: vi.fn().mockResolvedValue(false),
        flush: vi.fn().mockResolvedValue(undefined),
      },
    }),
  },
  {
    name: "update_agent_request",
    handlerMessage: "session: update_agent_request error",
    message: {
      type: "update_agent_request",
      agentId: "agent-update",
      name: "renamed",
      requestId: "req-update",
    },
    overrides: (failure) => agentStub(failure, "updateAgentMetadata"),
  },
  {
    name: "project.rename.request",
    handlerMessage: "session: project.rename.request error",
    message: {
      type: "project.rename.request",
      projectId: "project-rename",
      customName: "Name",
      requestId: "req-rename",
    },
    overrides: (failure) => ({ projectRegistry: { get: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "project.remove.request",
    handlerMessage: "session: project.remove.request error",
    requestType: "project.remove.request",
    message: {
      type: "project.remove.request",
      projectId: "project-remove",
      requestId: "req-remove",
    },
    overrides: (failure) => ({ projectRegistry: { get: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "clear_agent_attention",
    handlerMessage: "Failed to clear agent attention",
    message: {
      type: "clear_agent_attention",
      agentId: "agent-attention",
      requestId: "req-attention",
    },
    overrides: (failure) => loadFailureStub(failure, "agent-attention"),
  },
  {
    name: "fetch_agent_timeline_request",
    handlerMessage: "Failed to handle fetch_agent_timeline_request",
    requestType: "fetch_agent_timeline_request",
    message: {
      type: "fetch_agent_timeline_request",
      agentId: "agent-timeline",
      requestId: "req-timeline",
    },
    overrides: (failure) => loadFailureStub(failure, "agent-timeline"),
  },
  {
    name: "agent.fork_context.request",
    handlerMessage: "Failed to handle agent.fork_context.request",
    requestType: "agent.fork_context.request",
    message: { type: "agent.fork_context.request", agentId: "agent-fork", requestId: "req-fork" },
    overrides: (failure) => loadFailureStub(failure, "agent-fork"),
  },
  {
    name: "archive_workspace_request",
    handlerMessage: "Failed to archive workspace",
    requestType: "archive_workspace_request",
    message: {
      type: "archive_workspace_request",
      workspaceId: "ws-archive",
      requestId: "req-archive",
    },
    overrides: (failure) => workspaceStub(failure),
  },
  {
    name: "workspace.mark_unread.request",
    handlerMessage: "Failed to mark workspace unread",
    requestType: "workspace.mark_unread.request",
    message: {
      type: "workspace.mark_unread.request",
      workspaceId: "ws-unread",
      requestId: "req-unread",
    },
    overrides: (failure) => workspaceStub(failure),
  },
];

describe("request outcome logging per handler", () => {
  for (const handlerCase of handlerOutcomeCases) {
    test(`${handlerCase.name} logs a request outcome below error`, async () => {
      const { logger, records } = createRecordingLogger();
      const session = createSessionForTest({
        logger,
        messages: [],
        ...handlerCase.overrides(new RequestOutcomeError("not available")),
      });

      await session.handleMessage(handlerCase.message);

      // One record, and it is the injected outcome — not some other failure the handler caught.
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: 40,
        msg: "Request could not be answered",
        error: "not available",
      });
      // Exact, so a row that passes no request type notices one appearing.
      expect(records[0]?.requestType).toBe(handlerCase.requestType);
    });

    test(`${handlerCase.name} still logs an ordinary failure at error`, async () => {
      const { logger, records } = createRecordingLogger();
      const session = createSessionForTest({
        logger,
        ...handlerCase.overrides(new Error("boom")),
      });

      await session.handleMessage(handlerCase.message);

      // One record, the handler's own message, and the injected error — not a createStub TypeError.
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: 50,
        msg: handlerCase.handlerMessage,
        error: "boom",
      });
      expect(records[0]?.requestType).toBe(handlerCase.requestType);
    });
  }
});
