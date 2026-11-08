import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, test, vi } from "vitest";

import {
  createRecordingLogger,
  createSessionForTest,
  createStoredAgentRecord,
  type SessionForTestOptions,
} from "./session.test-harness.js";
import type { SessionInboundMessage } from "./messages.js";
import { RequestOutcomeError } from "./request-outcome.js";

// The GitHub-clone handler runs a real git clone; the clone command is the only
// module the outcome rows replace, so the row can fail there and nowhere else.
const gitCommandMocks = vi.hoisted(() => ({ runGitCommand: vi.fn() }));

vi.mock("../utils/run-git-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/run-git-command.js")>();
  return { ...actual, runGitCommand: gitCommandMocks.runGitCommand };
});

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

// The three agent-directory reads (fetch_agents, agent history, workspaces) all reach the live
// agent list first, so one throwing listAgents is the first call that can fail in each.
function listAgentsFailure(failure: Error): Partial<SessionForTestOptions> {
  return {
    agentManager: {
      listAgents: vi.fn(() => {
        throw failure;
      }),
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
  {
    name: "create_agent_request",
    handlerMessage: "Failed to create agent",
    requestType: "create_agent_request",
    message: {
      type: "create_agent_request",
      requestId: "req-create",
      config: { provider: "codex", cwd: "/tmp/agent-create" },
      attachments: [],
    },
    // createSessionAgent probes the requested directory before anything else in its try.
    overrides: (failure) => ({ filesystem: { isDirectory: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "resume_agent_request",
    handlerMessage: "Failed to resume agent",
    requestType: "resume_agent_request",
    message: {
      type: "resume_agent_request",
      requestId: "req-resume",
      handle: { provider: "codex", sessionId: "session-resume" },
    },
    // unarchiveAgentByHandle resolves the stored record by provider session first.
    overrides: (failure) => ({
      agentStorage: { listByProviderSession: vi.fn().mockRejectedValue(failure) },
    }),
  },
  {
    name: "import_agent_request",
    handlerMessage: "Failed to import agent",
    requestType: "import_agent_request",
    message: {
      type: "import_agent_request",
      requestId: "req-import",
      provider: "codex",
      providerHandleId: "provider-handle-import",
      cwd: "/tmp/agent-import",
    },
    // importProviderSession derives its mutation key from the stored records first.
    overrides: (failure) => ({
      agentStorage: { listByProviderSession: vi.fn().mockRejectedValue(failure) },
    }),
  },
  {
    name: "agent.detach.request",
    handlerMessage: "Failed to detach agent",
    message: { type: "agent.detach.request", agentId: "agent-detach", requestId: "req-detach" },
    overrides: (failure) => agentStub(failure, "detachAgent"),
  },
  {
    name: "cancel_agent_request",
    handlerMessage: "Failed to cancel running agent on request for agent agent-cancel",
    message: {
      type: "cancel_agent_request",
      agentId: "agent-cancel",
      requestId: "req-cancel",
    },
    // requestAgentRunCancellation reads the live agent first; the catch reads it again to answer.
    overrides: (failure) => ({
      agentManager: {
        getAgent: vi
          .fn()
          .mockImplementationOnce(() => {
            throw failure;
          })
          .mockReturnValue(null),
      },
    }),
  },
  {
    name: "refresh_agent_request",
    handlerMessage: "Failed to refresh agent agent-refresh",
    requestType: "refresh_agent_request",
    message: {
      type: "refresh_agent_request",
      agentId: "agent-refresh",
      requestId: "req-refresh",
    },
    // The legacy workspace-restore branch is inert without an appVersion, so unarchiveAgentState's
    // snapshot unarchive is the first call inside the try.
    overrides: (failure) => ({
      agentManager: { unarchiveSnapshot: vi.fn().mockRejectedValue(failure) },
    }),
  },
  {
    name: "list_commands_request",
    handlerMessage: "Failed to list commands",
    requestType: "list_commands_request",
    message: {
      type: "list_commands_request",
      agentId: "agent-commands",
      requestId: "req-commands",
    },
    overrides: (failure) => ({
      agentManager: {
        getAgent: vi.fn(() => {
          throw failure;
        }),
      },
    }),
  },
  {
    name: "fetch_agents_request",
    handlerMessage: "Failed to handle fetch_agents_request",
    requestType: "fetch_agents_request",
    message: { type: "fetch_agents_request", requestId: "req-fetch-agents" },
    overrides: listAgentsFailure,
  },
  {
    name: "fetch_agent_history_request",
    handlerMessage: "Failed to handle fetch_agent_history_request",
    requestType: "fetch_agent_history_request",
    message: { type: "fetch_agent_history_request", requestId: "req-agent-history" },
    overrides: listAgentsFailure,
  },
  {
    name: "fetch_recent_provider_sessions_request",
    handlerMessage: "Failed to handle fetch_recent_provider_sessions_request",
    requestType: "fetch_recent_provider_sessions_request",
    message: { type: "fetch_recent_provider_sessions_request", requestId: "req-provider-sessions" },
    // collectImportedProviderSessions lists the stored records before asking any provider.
    overrides: (failure) => ({ agentStorage: { list: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "fetch_workspaces_request",
    handlerMessage: "Failed to handle fetch_workspaces_request",
    requestType: "fetch_workspaces_request",
    message: { type: "fetch_workspaces_request", requestId: "req-fetch-workspaces" },
    overrides: listAgentsFailure,
  },
  {
    name: "open_project_request",
    handlerMessage: "Failed to open project",
    requestType: "open_project_request",
    // A real directory passes the preflight, so the project read inside the try is first.
    message: { type: "open_project_request", cwd: tmpdir(), requestId: "req-open-project" },
    overrides: (failure) => ({ projectRegistry: { list: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "project.add.request",
    handlerMessage: "Failed to add project",
    requestType: "project.add.request",
    // A real directory passes the preflight, so the project read inside the try is first.
    message: { type: "project.add.request", cwd: tmpdir(), requestId: "req-add-project" },
    overrides: (failure) => ({ projectRegistry: { list: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "project.github.clone.request",
    handlerMessage: "Failed to clone GitHub project",
    requestType: "project.github.clone.request",
    message: {
      type: "project.github.clone.request",
      repo: "paseo/clone-row",
      cloneProtocol: "https",
      targetDirectory: join(tmpdir(), "paseo-clone-outcome-row"),
      requestId: "req-clone",
    },
    // mkdir/lstat/mkdtemp are real filesystem calls under a fresh temp directory; the clone itself
    // is the first call that can fail.
    overrides: (failure) => {
      gitCommandMocks.runGitCommand.mockRejectedValueOnce(failure);
      return {};
    },
  },
  {
    name: "workspace.title.set.request",
    handlerMessage: "session: workspace.title.set.request error",
    message: {
      type: "workspace.title.set.request",
      workspaceId: "ws-title",
      title: "Renamed",
      requestId: "req-title",
    },
    // The title write is the handler's first call inside its try.
    overrides: (failure) => ({
      workspaceRegistry: { get: vi.fn(), update: vi.fn().mockRejectedValue(failure) },
    }),
  },
  {
    name: "workspace.clear_attention.request",
    handlerMessage: "Failed to clear workspace attention",
    requestType: "workspace.clear_attention.request",
    message: {
      type: "workspace.clear_attention.request",
      workspaceId: "ws-clear",
      requestId: "req-clear",
    },
    // The per-workspace loop reads the workspace record before it touches any agent.
    overrides: (failure) => ({ workspaceRegistry: { get: vi.fn().mockRejectedValue(failure) } }),
  },
  {
    name: "agent.timeline.list_prompts.request",
    handlerMessage: "Failed to handle agent.timeline.list_prompts.request",
    requestType: "agent.timeline.list_prompts.request",
    message: {
      type: "agent.timeline.list_prompts.request",
      agentId: "agent-prompts",
      requestId: "req-prompts",
    },
    // ensureAgentLoaded waits on the close barrier, then reads the stored record: that read is the
    // first call that can fail.
    overrides: (failure) => ({
      agentStorage: { get: vi.fn().mockRejectedValue(failure) },
      agentManager: {
        getAgent: vi.fn(() => undefined),
        waitForAgentClose: vi.fn().mockResolvedValue(undefined),
      },
    }),
  },
  {
    name: "wait_for_finish_request",
    handlerMessage: "wait_for_finish_request failed",
    message: { type: "wait_for_finish_request", agentId: "agent-wait", requestId: "req-wait" },
    // resolveAgentIdentifier resolves the id from storage (first getAgent, then the stored list),
    // and the wait path's own read of the live agent is the second call — only that one fails.
    overrides: (failure) => ({
      agentStorage: {
        list: vi
          .fn()
          .mockResolvedValue([createStoredAgentRecord({ id: "agent-wait", cwd: "/tmp/agent" })]),
      },
      agentManager: {
        getAgent: vi
          .fn()
          .mockReturnValueOnce(undefined)
          .mockImplementationOnce(() => {
            throw failure;
          })
          .mockReturnValue(undefined),
      },
    }),
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
