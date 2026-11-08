import pino from "pino";
import { vi } from "vitest";

import {
  createWorkspaceRuntimeStore,
  type WorkspaceRuntimeStore,
} from "./workspace-runtime-store/index.js";
import {
  createAgentMessageDeliveryStub,
  createMessageReceiptsStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";
import { Session, type SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { WorkspaceLabelService } from "./workspace-labels/index.js";
import type { SessionOutboundMessage } from "./messages.js";
import type { ForgeService } from "../services/forge-service.js";
import type { GitHubService } from "../services/github-service.js";
import {
  asSessionLogger,
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  asCheckoutDiffManager,
  asGitHubService,
  asWorkspaceGitService,
  asDaemonConfigStore,
  asWorkspaceAutoName,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";

export function createBinaryMessageHandler(
  binaryMessages: Uint8Array[] | undefined,
): ((frame: Uint8Array) => void) | undefined {
  if (!binaryMessages) {
    return undefined;
  }
  return (frame) => {
    binaryMessages.push(frame);
  };
}

export interface SessionForTestOptions {
  workspaceRuntimeStore?: WorkspaceRuntimeStore;
  sendToSource?: SessionOptions["onMessageToSource"];
  clientId?: string;
  permissions?: readonly DaemonPermission[];
  agentManager?: { [K in keyof SessionOptions["agentManager"]]?: unknown };
  agentStorage?: { [K in keyof SessionOptions["agentStorage"]]?: unknown };
  github?: Partial<ForgeService & GitHubService>;
  checkoutDiffManager?: { scheduleRefreshForCwd: ReturnType<typeof vi.fn> };
  workspaceGitService?: {
    getCheckout?: ReturnType<typeof vi.fn>;
    getCheckoutDiff?: ReturnType<typeof vi.fn>;
    getSnapshot?: ReturnType<typeof vi.fn>;
    suggestBranchesForCwd?: ReturnType<typeof vi.fn>;
    listStashes?: ReturnType<typeof vi.fn>;
    validateBranchRef?: ReturnType<typeof vi.fn>;
    hasLocalBranch?: ReturnType<typeof vi.fn>;
    resolveRepoRemoteUrl?: ReturnType<typeof vi.fn>;
    resolveRepoRoot?: ReturnType<typeof vi.fn>;
    resolveForge?: ReturnType<typeof vi.fn>;
    getWorkspaceGitMetadata?: ReturnType<typeof vi.fn>;
    getProjectSlug?: ReturnType<typeof vi.fn>;
  };
  workspaceRegistry?: { get: ReturnType<typeof vi.fn> };
  projectRegistry?: Partial<SessionOptions["projectRegistry"]>;
  terminalManager?: SessionOptions["terminalManager"];
  serviceProxy?: SessionOptions["serviceProxy"];
  scriptRuntimeStore?: SessionOptions["scriptRuntimeStore"];
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  providerSnapshotManager?: ProviderSnapshotManager;
  hubExecutionAgents?: SessionOptions["hubExecutionAgents"];
  stt?: SessionOptions["stt"];
  voice?: SessionOptions["voice"];
  paseoHome?: string;
  serverId?: SessionOptions["serverId"];
  daemonVersion?: SessionOptions["daemonVersion"];
  daemonRuntimeConfig?: SessionOptions["daemonRuntimeConfig"];
  downloadTokenStore?: SessionOptions["downloadTokenStore"];
  pushNotifications?: SessionOptions["pushNotifications"];
  messages?: unknown[];
  targetedMessages?: Array<{ source: object; message: SessionOutboundMessage }>;
  binaryMessages?: Uint8Array[];
  pluginRuntime?: SessionOptions["pluginRuntime"];
  orchestrationSkills?: SessionOptions["orchestrationSkills"];
  workspaceLabelService?: WorkspaceLabelService;
  logger?: SessionOptions["logger"];
}
export function createSessionForTest(options: SessionForTestOptions = {}): Session {
  const logger = options.logger ?? pino({ level: "silent" });
  const github = options.github ?? {
    invalidate: vi.fn(),
    searchIssuesAndPrs: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
  };
  const checkoutDiffManager = options.checkoutDiffManager ?? {
    scheduleRefreshForCwd: vi.fn(),
  };
  const workspaceGitService = {
    getCheckout: vi.fn(),
    getCheckoutDiff: vi.fn(),
    getSnapshot: vi.fn(),
    suggestBranchesForCwd: vi.fn(),
    listStashes: vi.fn(),

    validateBranchRef: vi.fn(),
    hasLocalBranch: vi.fn(),
    resolveRepoRemoteUrl: vi.fn(),
    resolveRepoRoot: vi.fn(),
    getWorkspaceGitMetadata: vi.fn(),
    resolveForge: vi.fn().mockResolvedValue({ forge: "github", service: github }),
    // Mirror production: invalidateForge resolves the forge and busts the
    // adapter's cache. The resolved forge here is github, so delegate to it.
    invalidateForge: vi.fn((cwd: string) => github.invalidate?.({ cwd })),
    getProjectSlug: vi.fn(),
    ...options.workspaceGitService,
  };
  const messages = options.messages ?? [];

  const sessionOptions: SessionOptions = {
    workspaceRuntimeStore: options.workspaceRuntimeStore ?? createWorkspaceRuntimeStore(),
    messageReceipts: createMessageReceiptsStub(),
    agentMessages: createAgentMessageDeliveryStub(),
    creationService: createTestCreationService(),
    clientId: options.clientId ?? "test-client",
    onMessage: (message) => messages.push(message),
    ...(options.targetedMessages
      ? {
          onMessageToSource: (source: object, message: SessionOutboundMessage) => {
            options.targetedMessages?.push({ source, message });
          },
        }
      : {
          onMessageToSource: (_source: object, message: SessionOutboundMessage) => {
            messages.push(message);
          },
        }),
    onBinaryMessage: createBinaryMessageHandler(options.binaryMessages),
    logger,
    downloadTokenStore: options.downloadTokenStore ?? asDownloadTokenStore(),
    pushNotifications: options.pushNotifications ?? asPushNotifications(),
    paseoHome: options.paseoHome ?? "/tmp/paseo-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      listProviderSubagentActivity: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
      ...options.agentManager,
    }),
    agentStorage: asAgentStorage({
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      ...options.agentStorage,
    }),
    projectRegistry: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      getOrCreateActiveByRoot: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
      ...options.projectRegistry,
    } as SessionOptions["projectRegistry"],
    // Session only reads this registry through get/list; the cast is the same boundary
    // createStub owns elsewhere, kept here so the harness itself typechecks.
    workspaceRegistry: (options.workspaceRegistry ?? {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    }) as unknown as SessionOptions["workspaceRegistry"],
    workspaceLabelService: options.workspaceLabelService,
    workspaceAutoName: asWorkspaceAutoName(),
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager(checkoutDiffManager),
    github: asGitHubService(github),
    workspaceGitService: asWorkspaceGitService(workspaceGitService),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({
        mcp: { injectIntoAgents: false },
        providers: {},
      })),
      onChange: vi.fn(() => () => {}),
    }),
    pluginRuntime: options.pluginRuntime,
    orchestrationSkills: options.orchestrationSkills,
    stt: options.stt ?? null,
    tts: null,
    terminalManager: options.terminalManager ?? null,
    providerSnapshotManager:
      options.providerSnapshotManager ?? createProviderSnapshotManagerStub().manager,
    hubExecutionAgents: options.hubExecutionAgents,
    serviceProxy: options.serviceProxy,
    scriptRuntimeStore: options.scriptRuntimeStore,
    getDaemonTcpPort: options.getDaemonTcpPort,
    getDaemonTcpHost: options.getDaemonTcpHost,
    voice: options.voice,
    serverId: options.serverId,
    daemonVersion: options.daemonVersion,
    daemonRuntimeConfig: options.daemonRuntimeConfig,
    permissions: options.permissions ?? OWNER_PERMISSIONS,
  };
  if (options.sendToSource) sessionOptions.onMessageToSource = options.sendToSource;
  return new Session(sessionOptions);
}
export function createStoredAgentRecord(
  overrides: Pick<StoredAgentRecord, "id" | "cwd"> & Partial<StoredAgentRecord>,
): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    cwd: overrides.cwd,
    workspaceId: overrides.workspaceId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? null,
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "idle",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? null,
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence: overrides.persistence ?? null,
    lastError: overrides.lastError,
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason,
    attentionTimestamp: overrides.attentionTimestamp,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}
export interface RecordedLog {
  level: number;
  msg: string | undefined;
  requestType?: string;
  error?: string;
}

export function createRecordingLogger(): {
  logger: SessionOptions["logger"];
  records: RecordedLog[];
} {
  const records: RecordedLog[] = [];
  const record = (level: number) => (details: unknown, msg?: string) => {
    const context = details as { requestType?: string; err?: unknown } | null;
    const error = context?.err instanceof Error ? context.err.message : undefined;
    records.push({
      level,
      msg,
      ...(context?.requestType ? { requestType: context.requestType } : {}),
      ...(error ? { error } : {}),
    });
  };
  const logger: SessionOptions["logger"] = asSessionLogger({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: record(40),
    error: record(50),
    child: () => logger,
  });
  return { logger, records };
}
