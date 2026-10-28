import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderCommand,
  ProviderPermissionResponse,
  ProviderConfigChanges,
  ProviderError,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import {
  PLAN_SETTING_ID,
  modesFromPresets,
  parseModelId,
  planSetting,
  presetsFromHost,
  type CatalogValue,
  type PresetEntry,
} from "./catalog.js";
import { encodeContent } from "./prompt.js";
import {
  assistantMessageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  userMessageItem,
  type Json,
  type ToolRecord,
} from "./timeline.js";
import { DshError, type DshResult, type DshWire, type StreamHandle } from "./wire.js";

/**
 * One Paseo session backed by one DSH session in the owned `dsh web` host.
 *
 * The host is the same one the DSH browser client drives, so everything native
 * lives here: the command plane (`commands/list` → Paseo's composer,
 * `commands/execute` → real `/goal` and `/plan`), the goal and plan
 * projections, and the durable session log.
 */

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ sessionId: z.string().min(1) }).strict() })
  .strict();

interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data?: Record<string, unknown>;
}

interface SnapshotProjections {
  values?: {
    title?: string | null;
    agentPreset?: string | null;
    sessionListMetadata?: { blank?: boolean; lastPromptAt?: number | null };
    plan?: { active?: boolean; pending?: boolean };
    permissions?: { currentValue?: string };
    modelSelection?: {
      lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
      next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
    };
    goal?: {
      goal?: { objective?: string; phase?: string; roundsStarted?: number };
    } | null;
  };
}

interface FollowSnapshot {
  type: "snapshot";
  header?: { id?: string; cwd?: string };
  cursor?: number;
  records?: Array<{ type: string; event?: SessionEvent }>;
  projections?: SnapshotProjections;
}

interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  wire: DshWire;
  capabilities: readonly string[];
  catalog: () => CatalogValue | null;
  emit: (event: ProviderEvent) => void;
  onClosed: () => void;
  /** Answer a `$events` waterfall (the host's human-interaction channel). */
  answerWaterfall: (eventId: string, outcome: Json) => Promise<DshResult>;
}

/** One host question call waiting for a human answer. */
interface PendingQuestion {
  permissionId: string;
  eventId: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

const SNAPSHOT_TIMEOUT_MS = 30_000;
/** The Paseo settings id for DSH's permission preset. */
const PERMISSION_SETTING_ID = "permission_preset";
const INTERRUPT_SETTLE_MS = 10_000;
/** Commands Paseo cannot present as a result (a ZIP download); the host still lists them. */
const HIDDEN_COMMANDS = new Set(["export"]);

export class Session {
  private readonly options: SessionOptions;
  private config: ProviderSessionConfig;
  private nativeId: string;
  private follow: StreamHandle | null = null;
  private opened = false;
  private closed = false;
  private replayDone = false;
  private planActive = false;

  /** The DSH session id this Paseo session drives (waterfall routing). */
  get dshSessionId(): string | undefined {
    return this.nativeId;
  }

  private presets: PresetEntry[] = [];
  private currentPreset: string | undefined;
  private permissionPreset: string | undefined;
  private permissionOptions: Array<{ value: string; name: string; description?: string }> = [];
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** DSH fixes the agent preset at the first turn; until then it can be selected. */
  private blank = true;
  private selectedModel: string | undefined;
  private thinkingOption: string | undefined;
  private commands: ProviderCommand[] = [];
  private readonly tools = new Map<string, ToolRecord>();
  /** Turn ids minted at prompt admission, adopted by the next `turn/start`. */
  private readonly pendingTurns: string[] = [];
  private currentTurn: { id: string; dshTurn: number; usage: TurnUsage } | null = null;
  private snapshotWaiters: Array<{
    resolve: (snapshot: FollowSnapshot) => void;
    reject: (error: Error) => void;
  }> = [];
  private interruptTimer: NodeJS.Timeout | undefined;

  constructor(options: SessionOptions) {
    this.options = options;
    this.config = { ...options.config };
    this.nativeId = "";
  }

  get id(): string {
    return this.options.id;
  }

  get persistence(): ProviderPersistence {
    return { version: 1, data: { sessionId: this.nativeId } };
  }

  /** Open or resume the DSH session and finish Paseo's fixed open sequence. */
  async open(
    requestId: string,
    persistence: ProviderPersistence | undefined,
    history: "replay" | "skip",
  ): Promise<void> {
    const adopted =
      persistence === undefined ? undefined : persistenceSchema.parse(persistence).data.sessionId;
    const created = await this.options.wire.call("session/create", {
      request: {
        cwd: this.config.cwd,
        ...(adopted === undefined ? {} : { sessionId: adopted }),
        ...(this.config.mode === undefined ? {} : { agentPreset: this.config.mode }),
      },
    });
    if (!created.ok) throw new DshError(created.error.message, created.error.code);
    const value = created.value as { sessionId?: unknown; agentPreset?: unknown };
    if (typeof value.sessionId !== "string" || value.sessionId === "") {
      throw new DshError("dsh did not name the created Session", "SESSION_UNNAMED");
    }
    this.nativeId = value.sessionId;
    if (typeof value.agentPreset === "string") this.currentPreset = value.agentPreset;
    this.options.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities: this.options.capabilities,
      restoration: "core",
      persistence: this.config.persist ? this.persistence : undefined,
      cwd: this.config.cwd,
    });

    const snapshot = await this.startFollow();
    this.adoptSnapshot(snapshot);
    await this.loadPresets();
    await this.loadPermissionCatalog();
    this.emitConfig();
    await this.loadCommands();
    if (history === "replay") this.replay(snapshot);
    this.replayDone = true;
    this.opened = true;
    this.options.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) throw new DshError("DSH session is closed", "SESSION_CLOSED");
    if (prompt.input.type === "command") {
      await this.executeCommand(prompt);
      return;
    }
    await this.sendMessage(prompt);
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (this.closed) throw new DshError("DSH session is closed", "SESSION_CLOSED");
    const settings = changes.settings ?? {};
    for (const key of Object.keys(settings)) {
      if (key !== PLAN_SETTING_ID && key !== PERMISSION_SETTING_ID) {
        throw new DshError(`DSH has no setting ${JSON.stringify(key)}`, "UNSUPPORTED_SETTING");
      }
    }
    if (typeof settings[PLAN_SETTING_ID] === "boolean") {
      const active = settings[PLAN_SETTING_ID];
      await this.runLine(active ? "/plan" : "/plan off");
      this.planActive = active;
    }
    await this.applyPermissionSetting(settings[PERMISSION_SETTING_ID]);
    if (changes.mode !== undefined && changes.mode !== null) {
      await this.selectPreset(changes.mode);
    }
    await this.applyModelSelection(changes);
    this.emitConfig();
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    const result = await this.options.wire.call("session/cancel", {
      request: { sessionId: this.nativeId },
    });
    if (!result.ok) throw new DshError(result.error.message, result.error.code);
    const turn = this.currentTurn;
    if (turn === null) return;
    // A host that acknowledges the cancel but never closes the turn would leave
    // the daemon waiting forever; settle it ourselves after a bounded grace.
    if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = undefined;
      if (this.currentTurn?.id === turn.id) this.finishTurn(turn, "canceled", undefined);
    }, INTERRUPT_SETTLE_MS);
    this.interruptTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
    this.follow?.cancel();
    this.follow = null;
    this.options.emit({ type: "session.closed", sessionId: this.options.id });
    this.options.onClosed();
  }

  /** The host process died: every session it owned is unusable. */
  hostFailed(message: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
    this.options.emit({
      type: "session.runtime_failed",
      sessionId: this.options.id,
      error: { message, code: "HOST_EXITED" },
    });
    this.options.onClosed();
  }

  private async sendMessage(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type !== "message") return;
    if (prompt.outputSchema !== undefined) {
      this.failPrompt(
        prompt.clientMessageId,
        "DSH has no structured output mode",
        "UNSUPPORTED_OUTPUT_SCHEMA",
      );
      return;
    }
    const steering = prompt.delivery === "steer";
    const active = this.currentTurn;
    if (steering && active === null) {
      this.failPrompt(prompt.clientMessageId, "There is no active turn to steer", "NO_ACTIVE_TURN");
      return;
    }
    const content = encodeContent(prompt);
    if (content.length === 0) {
      this.failPrompt(
        prompt.clientMessageId,
        "The prompt has no content DSH can receive",
        "EMPTY_PROMPT",
      );
      return;
    }
    const turnId = steering && active !== null ? active.id : randomUUID();
    // dsh may start the turn before this call returns; the id must be queued
    // first or `turn/start` mints a second one and the daemon waits forever.
    if (!steering) this.pendingTurns.push(turnId);
    const result = await this.options.wire.call("session/prompt", {
      request: {
        requestId: prompt.clientMessageId,
        sessionId: this.nativeId,
        mode: steering ? "steer" : "queue",
        content,
      },
    });
    if (!result.ok) {
      if (!steering) this.forgetPendingTurn(turnId);
      this.failPrompt(prompt.clientMessageId, result.error.message, result.error.code);
      return;
    }
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: steering ? { type: "steer", turnId } : { type: "turn", turnId },
    });
  }

  private async executeCommand(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type !== "command") return;
    const line = `/${prompt.input.name}${prompt.input.arguments === "" ? "" : ` ${prompt.input.arguments}`}`;
    const result = await this.options.wire.call("commands/execute", {
      agentId: this.nativeId,
      line,
      submittedAttachments: [],
    });
    if (!result.ok) {
      this.failPrompt(prompt.clientMessageId, result.error.message, result.error.code);
      return;
    }
    const value = result.value as
      | { commandId?: unknown; result?: { kind?: unknown; text?: unknown } }
      | undefined;
    if (value === undefined) {
      this.failPrompt(
        prompt.clientMessageId,
        `Unknown or malformed command: ${line}`,
        "UNKNOWN_COMMAND",
      );
      return;
    }
    if (value.result?.kind === "error") {
      this.failPrompt(
        prompt.clientMessageId,
        typeof value.result.text === "string" ? value.result.text : `${line} failed`,
        "COMMAND_FAILED",
      );
      return;
    }
    // Handled without a model turn: the daemon synthesizes start/complete and the
    // command's own lifecycle events carry the visible result.
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "completed" },
    });
  }

  /** Run a command line as a control action (mode switches), not as a prompt. */
  private async runLine(line: string): Promise<void> {
    const result = await this.options.wire.call("commands/execute", {
      agentId: this.nativeId,
      line,
      submittedAttachments: [],
    });
    if (!result.ok) throw new DshError(result.error.message, result.error.code);
    const value = result.value as { result?: { kind?: unknown; text?: unknown } } | undefined;
    if (value === undefined) throw new DshError(`Unknown command: ${line}`, "UNKNOWN_COMMAND");
    if (value.result?.kind === "error") {
      throw new DshError(
        typeof value.result.text === "string" ? value.result.text : `${line} failed`,
        "COMMAND_FAILED",
      );
    }
  }

  /** Drop a turn id whose prompt never reached the host. */
  private forgetPendingTurn(turnId: string): void {
    const index = this.pendingTurns.indexOf(turnId);
    if (index >= 0) this.pendingTurns.splice(index, 1);
  }

  private failPrompt(clientMessageId: string, message: string, code?: string): void {
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId,
      result: { type: "failed", error: code === undefined ? { message } : { message, code } },
    });
  }

  private async loadCommands(): Promise<void> {
    const result = await this.options.wire.call("commands/list", { agentId: this.nativeId });
    if (!result.ok) return;
    const list = Array.isArray(result.value) ? result.value : [];
    const commands: ProviderCommand[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const value = entry as { name?: unknown; description?: unknown; input?: { hint?: unknown } };
      if (typeof value.name !== "string" || value.name === "") continue;
      if (HIDDEN_COMMANDS.has(value.name)) continue;
      commands.push({
        name: value.name,
        description:
          typeof value.description === "string" && value.description !== ""
            ? value.description
            : value.name,
        ...(typeof value.input?.hint === "string" ? { argumentHint: value.input.hint } : {}),
      });
    }
    this.commands = commands;
    this.options.emit({ type: "session.commands", sessionId: this.options.id, commands });
  }

  private async startFollow(): Promise<FollowSnapshot> {
    const snapshot = new Promise<FollowSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DshError("dsh did not send the session baseline in time", "SNAPSHOT_TIMEOUT"));
      }, SNAPSHOT_TIMEOUT_MS);
      timer.unref?.();
      this.snapshotWaiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.openFollowStream();
    return snapshot;
  }

  private openFollowStream(): void {
    this.follow = this.options.wire.open(
      "session/follow",
      { request: { address: { kind: "session", sessionId: this.nativeId } } },
      {
        item: (value) => {
          this.acceptFrame(value);
        },
        end: () => {
          this.follow = null;
          if (!this.closed) this.reopenFollow();
        },
        error: (error) => {
          this.follow = null;
          if (!this.opened) {
            const waiter = this.snapshotWaiters.shift();
            waiter?.reject(new DshError(error.message, error.code));
          }
          if (this.closed) return;
          if (error.code === "upstream-lost") {
            this.reopenFollow();
            return;
          }
          this.options.emit({
            type: "session.notice",
            sessionId: this.options.id,
            notice: {
              id: `follow-${randomUUID()}`,
              severity: "warning",
              title: "Lost the DSH session stream",
              description: error.message,
            },
          });
          this.reopenFollow();
        },
      },
    );
  }

  private reopenFollow(): void {
    // dsh has no stream resumption; the mux redials and the reopened follow gets
    // a fresh baseline. Timeline ids are stable, so the replay updates instead of
    // duplicating.
    const retry = (): void => {
      if (this.closed) return;
      this.openFollowStream();
    };
    const stop = this.options.wire.onConnection((state) => {
      if (!state.connected) return;
      stop();
      retry();
    });
    if (this.options.wire.connection.connected) {
      stop();
      retry();
    }
  }

  private acceptProjection(frame: { key?: unknown; value?: unknown }): void {
    if (frame.key !== "permissions") return;
    const value = frame.value as { currentValue?: unknown } | null | undefined;
    if (typeof value?.currentValue !== "string") return;
    if (this.permissionPreset === value.currentValue) return;
    this.permissionPreset = value.currentValue;
    if (this.opened) this.emitConfig();
  }

  /** A `$events` waterfall for this session: the host needs a human answer. */
  acceptWaterfall(event: string, eventId: string, request: Record<string, unknown>): void {
    if (event !== "user-questions/request") return;
    const questions = Array.isArray(request.questions)
      ? (request.questions as PendingQuestion["questions"])
      : [];
    // `ask_user_question` carries `wait.callId`; `exit_plan_mode` does not, and
    // the waterfall eventId is the identity either way.
    if (questions.length === 0) return;
    const permissionId = `dsh-question-${eventId}`;
    this.pendingQuestions.set(permissionId, {
      permissionId,
      eventId,
      questions,
    });
    const plan = questions.find((question) => question.id === "plan-review");
    if (plan !== undefined) {
      const planText = plan.detail ?? plan.question;
      this.options.emit({
        type: "session.permission",
        sessionId: this.options.id,
        request: {
          id: permissionId,
          name: "plan-review",
          kind: "plan",
          title: "Plan ready for review",
          description: planText,
          metadata: { planText },
          actions: [
            {
              id: "implement",
              label: "Implement",
              behavior: "allow",
              variant: "primary",
              intent: "implement",
            },
            {
              id: "dismiss",
              label: "Keep planning",
              behavior: "deny",
              variant: "secondary",
              intent: "dismiss",
            },
          ],
        },
      });
      return;
    }
    this.options.emit({
      type: "session.permission",
      sessionId: this.options.id,
      request: {
        id: permissionId,
        name: "user-question",
        kind: "question",
        title: questions[0]?.header ?? "Question",
        input: {
          questions: questions.map((question) => ({
            question: question.question,
            header: question.header ?? question.id,
            options: question.options ?? [],
            multiSelect: question.multiSelect === true,
            allowOther: true,
          })),
        },
      },
    });
  }

  /** The question was settled elsewhere (the DSH browser answered it). */
  onWaterfallCancel(eventId: string): void {
    const permissionId = `dsh-question-${eventId}`;
    if (!this.pendingQuestions.delete(permissionId)) return;
    this.options.emit({
      type: "session.permission_resolved",
      sessionId: this.options.id,
      permissionId,
    });
  }

  /** A Paseo permission response for one pending host question. */
  async answerPermission(
    permissionId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const pending = this.pendingQuestions.get(permissionId);
    if (pending === undefined) return;
    const answers = this.answersFor(pending, response);
    const result = await this.options.answerWaterfall(pending.eventId, {
      kind: "result",
      value: { answers },
    });
    if (!result.ok) throw new DshError(result.error.message, result.error.code);
    this.pendingQuestions.delete(permissionId);
    this.options.emit({
      type: "session.permission_resolved",
      sessionId: this.options.id,
      permissionId,
    });
  }

  private answersFor(
    pending: PendingQuestion,
    response: ProviderPermissionResponse,
  ): Array<{ id: string; selected: string[]; custom?: string }> {
    if (pending.questions.some((question) => question.id === "plan-review")) {
      return [
        {
          id: "plan-review",
          selected: [response.behavior === "allow" ? "Approve" : "Keep planning"],
          ...(response.behavior === "deny" && response.message !== undefined
            ? { custom: response.message }
            : {}),
        },
      ];
    }
    const provided =
      response.behavior === "allow" && typeof response.updatedInput === "object"
        ? (response.updatedInput.answers as Record<string, unknown> | undefined)
        : undefined;
    return pending.questions.map((question) => {
      const key = question.header ?? question.id;
      const value = provided?.[key];
      if (typeof value !== "string" || value.trim() === "") {
        return { id: question.id, selected: [] };
      }
      const labels = new Set((question.options ?? []).map((option) => option.label));
      const selected: string[] = [];
      const custom: string[] = [];
      for (const token of value
        .split(", ")
        .map((part) => part.trim())
        .filter(Boolean)) {
        if (labels.has(token)) selected.push(token);
        else custom.push(token);
      }
      return {
        id: question.id,
        selected,
        ...(custom.length === 0 ? {} : { custom: custom.join(", ") }),
      };
    });
  }

  private acceptFrame(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const frame = value as { type?: unknown };
    if (frame.type === "snapshot") {
      const snapshot = value as FollowSnapshot;
      const waiter = this.snapshotWaiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(snapshot);
        return;
      }
      this.adoptSnapshot(snapshot);
      if (this.opened && this.replayDone) this.replay(snapshot);
      return;
    }
    if (frame.type === "event") {
      const event = (value as { event?: SessionEvent }).event;
      if (event !== undefined) this.project(event, false);
      return;
    }
    if (frame.type === "projection") {
      this.acceptProjection(value as { key?: unknown; value?: unknown });
      return;
    }
    // `assistant-stream` is not requested; live text arrives with the committed
    // assistant message.
  }

  private adoptSnapshot(snapshot: FollowSnapshot): void {
    const values = snapshot.projections?.values;
    if (typeof values?.agentPreset === "string") this.currentPreset = values.agentPreset;
    if (values?.sessionListMetadata?.blank === false) this.blank = false;
    this.planActive = values?.plan?.active === true;
    this.adoptPermission(values?.permissions);
    this.adoptSelection(values?.modelSelection?.next ?? values?.modelSelection?.lastUsed);
    if (values?.goal?.goal !== undefined && values.goal.goal.objective !== undefined) {
      this.noticeGoal(values.goal.goal.objective, values.goal.goal.phase);
    }
  }

  private adoptPermission(permission: { currentValue?: string } | null | undefined): void {
    if (typeof permission?.currentValue === "string") {
      this.permissionPreset = permission.currentValue;
    }
  }

  private adoptSelection(
    selection: { provider?: string; model?: string; reasoningEffort?: string } | null | undefined,
  ): void {
    if (typeof selection?.provider === "string" && typeof selection.model === "string") {
      this.selectedModel = `${selection.provider}/${selection.model}`;
    }
    if (typeof selection?.reasoningEffort === "string")
      this.thinkingOption = selection.reasoningEffort;
  }

  private replay(snapshot: FollowSnapshot): void {
    for (const record of snapshot.records ?? []) {
      if (record.type === "event" && record.event !== undefined) this.project(record.event, true);
    }
  }

  private project(event: SessionEvent, replay: boolean): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "user/message":
        this.projectUserMessage(event, data);
        return;
      case "assistant/message":
        this.projectAssistantMessage(event, data, replay);
        return;
      case "tool/call":
        this.projectToolCall(event, data);
        return;
      case "tool/result":
        this.projectToolResult(data);
        return;
      case "turn/start":
        this.acceptTurnStart(data, replay);
        return;
      case "turn/end":
        this.acceptTurnEnd(data, replay);
        return;
      case "command/done":
        if (!replay) {
          this.options.emit({
            type: "session.notice",
            sessionId: this.options.id,
            notice: {
              id: `command-${String(data.commandId ?? event.seq)}`,
              severity: data.kind === "error" ? "error" : "info",
              title: "DSH command",
              description: typeof data.text === "string" ? data.text : undefined,
            },
          });
        }
        return;
      case "goal/change": {
        const goal = data.goal as { objective?: unknown; phase?: unknown } | undefined;
        if (typeof goal?.objective === "string") this.noticeGoal(goal.objective, goal.phase);
        return;
      }
      case "plan/mode":
        this.setPlan(data.active === true, replay);
        return;
      case "model/selection":
        this.acceptModelSelection(data, replay);
        return;
      default:
        return;
    }
  }

  private projectUserMessage(event: SessionEvent, data: Record<string, unknown>): void {
    const source = data.source as { kind?: unknown; rpcId?: unknown } | undefined;
    // Injected context (runtime snapshot, skills, time) is a user/message too;
    // only the human's own prompt is a transcript entry.
    if (source?.kind !== "user") return;
    const text = textOf(data.content);
    if (text === null) return;
    const clientMessageId =
      typeof source.rpcId === "string" ? source.rpcId : `msg-${String(event.seq)}`;
    this.item(
      userMessageItem({
        id: `msg-${String(event.seq)}`,
        clientMessageId,
        text,
      }),
    );
  }

  private projectAssistantMessage(
    event: SessionEvent,
    data: Record<string, unknown>,
    replay: boolean,
  ): void {
    const message = data.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text.trim().length > 0) this.item(assistantMessageItem(`msg-${String(event.seq)}`, text));
    const reasoning = blocks
      .filter((block) => block.type === "reasoning" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (reasoning.trim().length > 0)
      this.item(reasoningItem(`reasoning-${String(event.seq)}`, reasoning));
    if (!replay) this.acceptUsage(data.usage);
  }

  private projectToolCall(event: SessionEvent, data: Record<string, unknown>): void {
    const callId = typeof data.callId === "string" ? data.callId : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (callId === undefined || name === undefined) return;
    const record = toolCallItem({
      id: `tool-${String(event.seq)}`,
      callId,
      tool: name,
      input: parseArguments(data.arguments),
    });
    this.tools.set(callId, record);
    this.item(record.item);
  }

  private projectToolResult(data: Record<string, unknown>): void {
    const message = data.message as
      | {
          toolCallId?: unknown;
          callId?: unknown;
          content?: unknown;
          isError?: unknown;
          source?: { callId?: unknown };
        }
      | undefined;
    let callId: string | undefined;
    if (typeof message?.toolCallId === "string") callId = message.toolCallId;
    else if (typeof message?.callId === "string") callId = message.callId;
    else if (typeof message?.source?.callId === "string") callId = message.source.callId;
    if (callId === undefined) return;
    const record = this.tools.get(callId);
    if (record === undefined) return;
    const output = textOf(message?.content) ?? undefined;
    const failed = message?.isError === true || data.error !== undefined;
    const updated = toolResultItem(record, {
      status: failed ? "failed" : "completed",
      ...(output === undefined ? {} : { output }),
      ...(failed ? { error: output ?? "DSH tool failed" } : {}),
    });
    this.tools.set(callId, updated);
    this.item(updated.item);
  }

  private acceptTurnStart(data: Record<string, unknown>, replay: boolean): void {
    this.blank = false;
    const dshTurn = typeof data.turn === "number" ? data.turn : 0;
    const id = this.pendingTurns.shift() ?? `turn-${String(dshTurn)}-${randomUUID()}`;
    this.currentTurn = { id, dshTurn, usage: { input: 0, cached: 0, output: 0 } };
    if (replay) return;
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: id,
      state: "started",
    });
  }

  private acceptTurnEnd(data: Record<string, unknown>, replay: boolean): void {
    const turn = this.currentTurn;
    if (turn === null) return;
    if (this.interruptTimer !== undefined) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = undefined;
    }
    const reason = data.reason as
      | { kind?: unknown; error?: { message?: unknown; code?: unknown } }
      | undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : "completed";
    let state: "completed" | "failed" | "canceled" = "failed";
    if (kind === "completed") state = "completed";
    else if (kind === "aborted") state = "canceled";
    const error: ProviderError | undefined =
      state === "failed"
        ? {
            message:
              typeof reason?.error?.message === "string"
                ? reason.error.message
                : `DSH ended the turn with ${kind}`,
            ...(typeof reason?.error?.code === "string" ? { code: reason.error.code } : {}),
          }
        : undefined;
    this.finishTurn(turn, state, error, replay);
  }

  private finishTurn(
    turn: { id: string; dshTurn: number; usage: TurnUsage },
    state: "completed" | "failed" | "canceled",
    error: ProviderError | undefined,
    replay = false,
  ): void {
    this.currentTurn = null;
    if (turn.usage.output > 0) {
      this.options.emit({
        type: "session.usage",
        sessionId: this.options.id,
        turnId: turn.id,
        usage: this.usageOf(turn.usage),
      });
    }
    if (replay) return;
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state,
      ...(error === undefined ? {} : { error }),
    });
  }

  private acceptUsage(raw: unknown): void {
    const usage = raw as
      | {
          inputTokens?: unknown;
          outputTokens?: unknown;
          cacheReadTokens?: unknown;
          totalTokens?: unknown;
        }
      | undefined;
    const turn = this.currentTurn;
    if (turn === null || usage === undefined) return;
    turn.usage.input += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    turn.usage.cached += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
    turn.usage.output += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    turn.usage.total =
      typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : turn.usage.input + turn.usage.cached + turn.usage.output;
    this.options.emit({
      type: "session.usage",
      sessionId: this.options.id,
      turnId: turn.id,
      usage: this.usageOf(turn.usage),
    });
  }

  private usageOf(usage: TurnUsage): ProviderUsage {
    const model =
      this.selectedModel === undefined
        ? undefined
        : this.options.catalog()?.catalog.models.find((entry) => entry.id === this.selectedModel);
    return {
      inputTokens: usage.input,
      cachedInputTokens: usage.cached,
      outputTokens: usage.output,
      ...(usage.total === undefined ? {} : { contextWindowUsedTokens: usage.total }),
      ...(model?.contextWindowMaxTokens === undefined
        ? {}
        : { contextWindowMaxTokens: model.contextWindowMaxTokens }),
    };
  }

  private acceptModelSelection(data: Record<string, unknown>, replay: boolean): void {
    const provider = typeof data.provider === "string" ? data.provider : undefined;
    const model = typeof data.model === "string" ? data.model : undefined;
    const next =
      provider !== undefined && model !== undefined ? `${provider}/${model}` : this.selectedModel;
    const effort =
      typeof data.reasoningEffort === "string" ? data.reasoningEffort : this.thinkingOption;
    const changed = next !== this.selectedModel || effort !== this.thinkingOption;
    this.selectedModel = next;
    this.thinkingOption = effort;
    if (changed && !replay && this.opened) this.emitConfig();
  }

  private setPlan(active: boolean, replay: boolean): void {
    if (this.planActive === active) return;
    this.planActive = active;
    if (!replay && this.opened) this.emitConfig();
  }

  private noticeGoal(objective: string, phase: unknown): void {
    this.options.emit({
      type: "session.notice",
      sessionId: this.options.id,
      notice: {
        id: `goal-${objective.slice(0, 48)}`,
        severity: "info",
        title: typeof phase === "string" ? `Goal (${phase})` : "Goal",
        description: objective,
      },
    });
  }

  private async loadPermissionCatalog(): Promise<void> {
    const result = await this.options.wire.call("permissionPresets/catalog", {});
    if (!result.ok) return;
    const value = result.value as { options?: unknown } | null;
    if (!Array.isArray(value?.options)) return;
    const options: Array<{ value: string; name: string; description?: string }> = [];
    for (const entry of value.options) {
      if (typeof entry !== "object" || entry === null) continue;
      const option = entry as { value?: unknown; name?: unknown; description?: unknown };
      if (typeof option.value !== "string" || typeof option.name !== "string") continue;
      options.push({
        value: option.value,
        name: option.name,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      });
    }
    this.permissionOptions = options;
  }

  private async loadPresets(): Promise<void> {
    const result = await this.options.wire.call("agentPresets/list", {});
    if (!result.ok) return;
    this.presets = presetsFromHost(result.value);
  }

  /**
   * Select one agent preset. DSH records the preset on the Session's first turn
   * and then keeps that composition, so this is a pre-first-turn action; after
   * that the provider refuses instead of silently doing nothing.
   */
  private async applyModelSelection(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model === undefined && changes.thinkingOption === undefined) return;
    const model = changes.model === null ? undefined : (changes.model ?? this.selectedModel);
    const effort =
      changes.thinkingOption === null ? undefined : (changes.thinkingOption ?? this.thinkingOption);
    const parsed = model === undefined ? undefined : parseModelId(model);
    if (parsed === undefined) {
      throw new DshError("Choose a model before changing effort", "NO_MODEL");
    }
    const selected = await this.options.wire.call("session/selectModel", {
      request: {
        sessionId: this.nativeId,
        provider: parsed.provider,
        model: parsed.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      },
    });
    if (!selected.ok) throw new DshError(selected.error.message, selected.error.code);
    this.selectedModel = model;
    this.thinkingOption = effort;
  }

  private async applyPermissionSetting(value: unknown): Promise<void> {
    if (value === undefined) return;
    if (typeof value !== "string") {
      throw new DshError("The permission preset must be a string", "INVALID_SETTING");
    }
    if (!this.permissionOptions.some((option) => option.value === value)) {
      throw new DshError(
        `DSH has no permission preset ${JSON.stringify(value)}`,
        "INVALID_SETTING",
      );
    }
    await this.runLine(`/permission ${value}`);
    this.permissionPreset = value;
  }

  private async selectPreset(id: string): Promise<void> {
    if (!this.blank) {
      throw new DshError(
        "DSH fixes the agent preset at the session's first turn — start a new agent to change it",
        "PRESET_LOCKED",
      );
    }
    if (this.presets.length > 0 && !this.presets.some((preset) => preset.id === id)) {
      throw new DshError(`DSH has no agent preset ${JSON.stringify(id)}`, "INVALID_MODE");
    }
    const selected = await this.options.wire.call("agentPresets/select", {
      agentId: this.nativeId,
      agentPreset: id,
    });
    if (!selected.ok) throw new DshError(selected.error.message, selected.error.code);
    this.currentPreset = id;
  }

  private emitConfig(): void {
    const catalog = this.options.catalog()?.catalog;
    const { modes, mode } = modesFromPresets(this.presets, this.currentPreset);
    this.options.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        ...(this.selectedModel === undefined ? {} : { model: this.selectedModel }),
        ...(mode === undefined ? {} : { mode }),
        ...(this.thinkingOption === undefined ? {} : { thinkingOption: this.thinkingOption }),
        models: catalog?.models ?? [],
        modes,
        thinkingOptions: catalog?.thinkingOptions ?? [],
        settings: [
          planSetting(this.planActive),
          ...(this.permissionOptions.length === 0
            ? []
            : [
                {
                  type: "select" as const,
                  id: PERMISSION_SETTING_ID,
                  label: "Permissions",
                  description: "Sandbox and approval policy for this session",
                  value: this.permissionPreset ?? null,
                  options: this.permissionOptions.map((option) => ({
                    label: option.name,
                    value: option.value,
                  })),
                },
              ]),
        ],
      },
    });
  }

  private item(item: ProviderTimelineItem): void {
    this.options.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }
}

interface TurnUsage {
  input: number;
  cached: number;
  output: number;
  total?: number;
}

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const value = block as { type?: unknown; text?: unknown };
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
  }
  const text = parts.join("");
  return text.trim().length === 0 ? null : text;
}

function parseArguments(raw: unknown): Json {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Json;
    } catch {
      return { arguments: raw };
    }
  }
  return (raw ?? {}) as Json;
}
