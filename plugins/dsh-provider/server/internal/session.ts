import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderConfigChanges,
  ProviderError,
  ProviderEvent,
  ProviderLaunch,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import {
  callerPatchOf,
  disabledPluginsOf,
  patchYaml,
  profileOf,
  resolveSelection,
  validateSelection,
} from "./catalog.js";
import { composeTaskText, encodePrompt } from "./prompt.js";
import { startTurn, turnArgs, type TurnExit, type TurnProcess } from "./process.js";
import {
  assistantMessageItem,
  errorItem,
  reasoningItem,
  resultText,
  toolCallItem,
  toolResultItem,
  userMessageItem,
  type ToolRecord,
} from "./timeline.js";
import {
  DshError,
  diagnostic,
  isStaleSessionError,
  meaningfulStderr,
  type DshEvent,
  type DshStatus,
  type DshToolResult,
  type DshUsage,
} from "./wire.js";

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ sessionId: z.string().min(1) }).strict() })
  .strict();

interface Turn {
  id: string;
  /** DSH step index; thinking and text accumulate per step. */
  step: number;
  reasoning: Map<number, string>;
  text: Map<number, string>;
  tools: Map<string, ToolRecord>;
  assistantEmitted: boolean;
  outputTokens: number;
  usage: ProviderUsage | null;
  outcome: "completed" | "failed" | "canceled" | null;
  error: ProviderError | null;
  canceled: boolean;
  finalText: string | null;
  /** The exact user text, so a stale-session retry can resend it unchanged. */
  promptText: string;
  /** A stale `--session-id` retry happens at most once per turn. */
  retriedStale: boolean;
}

interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  catalog(): ProviderCatalog;
  persistence?: ProviderPersistence;
  emit(event: ProviderEvent): void;
}

/**
 * One DSH session is a chain of one-turn child processes. The native session id
 * learned from the first `session` event is what makes the chain a conversation:
 * every later turn resumes it with `--session-id`.
 */
export class Session {
  private config: ProviderSessionConfig;
  private nativeSessionId: string | null;
  private firstTurn: boolean;
  private turn: Turn | null = null;
  private child: TurnProcess | null = null;
  private patch: { directory: string; file: string } | null = null;
  private announcedSessionId: string | null = null;
  private closed = false;

  constructor(private readonly options: SessionOptions) {
    this.config = { ...options.config };
    this.nativeSessionId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.sessionId
      : null;
    this.firstTurn = this.nativeSessionId === null;
    validateSelection(this.config, options.catalog());
  }

  get profile(): string {
    return profileOf(this.config);
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    await this.writePatch();
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities,
      restoration: "core",
      persistence:
        this.config.persist && this.nativeSessionId !== null ? this.persistence() : undefined,
      cwd: this.config.cwd,
      title: this.config.title,
    });
    this.publishConfig();
    this.emit({ type: "session.commands", sessionId: this.options.id, commands: [] });
    this.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  /**
   * Spawn the turn and return as soon as the process is running: the daemon must
   * be able to interrupt while the turn is in flight.
   */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) throw new DshError("DSH session is closed", "SESSION_CLOSED");
    if (this.turn) throw new DshError("DSH is already running a turn", "TURN_ACTIVE");
    const text = encodePrompt(prompt);
    const turn: Turn = {
      id: randomUUID(),
      step: 0,
      reasoning: new Map(),
      text: new Map(),
      tools: new Map(),
      assistantEmitted: false,
      outputTokens: 0,
      usage: null,
      outcome: null,
      error: null,
      canceled: false,
      finalText: null,
      promptText: "",
      retriedStale: false,
    };
    this.turn = turn;
    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "started",
    });
    this.item(
      userMessageItem({
        id: prompt.clientMessageId,
        clientMessageId: prompt.clientMessageId,
        text,
      }),
    );
    try {
      this.child = this.spawn(turn, text);
    } catch (error) {
      const failure =
        error instanceof DshError
          ? error
          : new DshError(error instanceof Error ? error.message : String(error), "SPAWN_ERROR");
      this.turn = null;
      this.child = null;
      this.finishTools(turn, "failed");
      this.item(errorItem(`${turn.id}:error`, failure.message));
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "failed",
        error: { message: failure.message, code: failure.code },
      });
      throw failure;
    }
  }

  /**
   * Start one turn process. `text` is the user's prompt; the system preamble is
   * composed here so a retry composes it again for the replacement session.
   */
  private spawn(turn: Turn, text: string): TurnProcess {
    turn.promptText = text;
    const args = turnArgs({
      profile: this.profile,
      patchPaths: this.patchPaths(),
      sessionId: this.nativeSessionId,
      taskText: composeTaskText({
        systemPrompt: this.firstTurn ? this.config.systemPrompt : undefined,
        text,
      }),
    });
    return startTurn({
      launch: this.options.launch,
      config: this.config,
      args,
      onEvent: (event) => this.accept(event),
      onProtocolError: (error) => this.failTurn(error),
      onExit: (exit) => this.finish(exit),
    });
  }

  /** The caller's overlay first, then ours, so the session's model row wins. */
  private patchPaths(): string[] {
    const paths: string[] = [];
    const callerPatch = callerPatchOf(this.config);
    if (callerPatch) paths.push(callerPatch);
    if (this.patch) paths.push(this.patch.file);
    return paths;
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (this.closed) throw new DshError("DSH session is closed", "SESSION_CLOSED");
    if (changes.mode !== undefined && changes.mode !== null)
      throw new DshError("DSH has no modes", "INVALID_MODE");
    if (changes.settings && Object.keys(changes.settings).length > 0)
      throw new DshError("DSH has no configurable settings", "UNSUPPORTED_SETTING");
    const config: ProviderSessionConfig = {
      ...this.config,
      model: changes.model === null ? undefined : (changes.model ?? this.config.model),
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
    };
    validateSelection(config, this.options.catalog());
    this.config = config;
    await this.writePatch();
    this.publishConfig();
    if (this.turn)
      this.emit({
        type: "session.notice",
        sessionId: this.options.id,
        notice: {
          id: `${this.options.id}:pending-config`,
          severity: "info",
          title: "Model change applies to the next turn",
          description:
            "DSH runs one process per turn. The new model and thinking effort are used when the current turn finishes.",
        },
      });
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.canceled = true;
    const child = this.child;
    if (!child) {
      this.finish({ code: null, signal: "SIGTERM", stderr: "" });
      return;
    }
    await child.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn && this.child) {
      turn.canceled = true;
      await this.child.interrupt();
    }
    this.turn = null;
    this.child = null;
    await this.removePatch();
  }

  private accept(event: DshEvent): void {
    const turn = this.turn;
    if (!turn) return;
    // A protocol failure decides the turn; later events must not rewrite the outcome.
    if (turn.outcome === "failed") return;
    switch (event.type) {
      case "session":
        if (this.nativeSessionId !== null && this.nativeSessionId !== event.sessionId) {
          this.failTurn(
            new DshError(
              "DSH resumed a different session than the one requested",
              "INVALID_RESUME",
            ),
          );
          return;
        }
        this.nativeSessionId = event.sessionId;
        this.firstTurn = false;
        // Announce the native id once per session, not once per turn.
        if (this.config.persist && this.announcedSessionId !== event.sessionId) {
          this.announcedSessionId = event.sessionId;
          this.emit({
            type: "session.persistence",
            sessionId: this.options.id,
            persistence: this.persistence(),
          });
        }
        return;
      case "status":
        this.acceptStatus(event, turn);
        return;
      case "thinking":
        this.acceptThinking(event.text, turn);
        return;
      case "text":
        this.acceptText(event.text, turn);
        return;
      case "tool_call":
        this.acceptToolCall(event, turn);
        return;
      case "tool_result":
        this.acceptToolResult(event, turn);
        return;
      case "final":
        turn.finalText = event.text;
        if (!turn.assistantEmitted && event.text.trim()) {
          turn.assistantEmitted = true;
          this.item(assistantMessageItem(`${turn.id}:final`, event.text));
        }
        return;
      // A rejected invocation (`unknown option …`, missing session) arrives here
      // instead of a turn stream; it is the only explanation DSH gives.
      case "error":
        this.failTurn(new DshError(diagnostic(event.message), "DSH_ERROR"));
        return;
    }
  }

  /** Reasoning streams per step; re-emit the whole snapshot under one item id. */
  private acceptThinking(chunk: string, turn: Turn): void {
    const text = `${turn.reasoning.get(turn.step) ?? ""}${chunk}`;
    turn.reasoning.set(turn.step, text);
    if (text.trim()) this.item(reasoningItem(`${turn.id}:thinking:${turn.step}`, text));
  }

  /** Assistant text streams per step, so one step's text is one message item. */
  private acceptText(chunk: string, turn: Turn): void {
    const text = `${turn.text.get(turn.step) ?? ""}${chunk}`;
    turn.text.set(turn.step, text);
    if (!text) return;
    turn.assistantEmitted = true;
    this.item(assistantMessageItem(`${turn.id}:text:${turn.step}`, text));
  }

  private acceptToolCall(event: Extract<DshEvent, { type: "tool_call" }>, turn: Turn): void {
    const record = toolCallItem({
      id: `${turn.id}:tool:${event.callId}`,
      callId: event.callId,
      tool: event.tool,
      input: event.input ?? null,
    });
    turn.tools.set(event.callId, record);
    this.item(record.item);
  }

  private acceptStatus(event: DshStatus, turn: Turn): void {
    if (event.phase === "step_start") {
      turn.step = event.step ?? turn.step + 1;
      return;
    }
    if (event.phase === "step_end") {
      this.acceptUsage(event.usage, turn);
      return;
    }
    if (event.phase !== "turn_end") return;
    const reason = event.reason;
    if (!reason || reason.kind === "completed") {
      turn.outcome = "completed";
      return;
    }
    if (reason.kind === "error") {
      turn.outcome = "failed";
      const message = reason.error?.message ?? "DSH turn failed";
      const code = reason.error?.code;
      turn.error = code ? { message: diagnostic(message), code } : { message: diagnostic(message) };
      return;
    }
    if (/cancel|abort|interrupt/i.test(reason.kind)) {
      turn.outcome = "canceled";
      return;
    }
    turn.outcome = "failed";
    turn.error = { message: `DSH ended the turn with ${reason.kind}` };
  }

  /**
   * DSH reports per-step usage. `inputTokens` is the prompt size for that step,
   * not an additive total, so the last step describes the context; output tokens
   * accumulate across steps.
   */
  private acceptUsage(usage: DshUsage | undefined, turn: Turn): void {
    if (!usage) return;
    turn.outputTokens += usage.outputTokens;
    const contextTokens =
      usage.totalTokens > 0
        ? usage.totalTokens
        : usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
    const maxTokens = this.options
      .catalog()
      .models.find((model) => model.id === this.selectedModel)?.contextWindowMaxTokens;
    turn.usage = {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cacheReadTokens,
      outputTokens: turn.outputTokens,
      contextWindowUsedTokens: contextTokens,
      ...(maxTokens === undefined ? {} : { contextWindowMaxTokens: maxTokens }),
    };
    this.emit({
      type: "session.usage",
      sessionId: this.options.id,
      turnId: turn.id,
      usage: turn.usage,
    });
  }

  private acceptToolResult(event: DshToolResult, turn: Turn): void {
    const record = turn.tools.get(event.callId);
    if (!record) return;
    const output = resultText(event.result ?? event.error ?? undefined);
    const failed = event.status !== undefined && /fail|error/.test(event.status);
    const status = failed ? "failed" : "completed";
    const updated = toolResultItem(record, {
      status,
      output,
      ...(status === "failed" ? { error: output ?? "DSH tool failed" } : {}),
    });
    turn.tools.set(event.callId, updated);
    this.item(updated.item);
  }

  private failTurn(error: DshError): void {
    const turn = this.turn;
    if (!turn || turn.outcome === "failed") return;
    turn.outcome = "failed";
    turn.error = error.code
      ? { message: error.message, code: error.code }
      : { message: error.message };
    void this.child?.interrupt();
  }

  /** The child exited; this is the only place a turn is reported finished. */
  private finish(exit: TurnExit): void {
    const turn = this.turn;
    this.turn = null;
    this.child = null;
    if (!turn) return;
    if (turn.canceled || turn.outcome === "canceled") {
      this.finishTools(turn, "canceled");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "canceled",
      });
      return;
    }
    if (this.retryStaleSession(turn)) return;
    const error = this.turnFailure(turn, exit);
    if (error) {
      this.finishTools(turn, "failed");
      this.item(errorItem(`${turn.id}:error`, error.message));
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "failed",
        error,
      });
      return;
    }
    this.finishTools(turn, "completed");
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "completed",
    });
  }

  /** The failure to report, or null when the turn completed. */
  private turnFailure(turn: Turn, exit: TurnExit): ProviderError | null {
    if (turn.outcome === "completed") return null;
    if (turn.outcome === "failed") {
      return turn.error ?? this.exitFailure(turn, exit) ?? { message: "DSH turn failed" };
    }
    return this.exitFailure(turn, exit);
  }

  /**
   * A persisted DSH session that no longer exists fails every turn with
   * `session "…" does not exist`. Recreate it once and resend the same text, so a
   * cleaned session store cannot permanently brick the Paseo agent.
   */
  private retryStaleSession(turn: Turn): boolean {
    if (this.nativeSessionId === null || turn.retriedStale) return false;
    if (turn.outcome !== "failed" || !turn.error) return false;
    if (!isStaleSessionError(turn.error.message)) return false;
    turn.retriedStale = true;
    turn.outcome = null;
    turn.error = null;
    this.nativeSessionId = null;
    this.firstTurn = true;
    this.announcedSessionId = null;
    this.emit({
      type: "session.notice",
      sessionId: this.options.id,
      notice: {
        id: `${this.options.id}:stale-session`,
        severity: "warning",
        title: "DSH session had expired",
        description:
          "The saved DSH session no longer exists, so this turn started a fresh one. Earlier turns are not carried over.",
      },
    });
    try {
      this.child = this.spawn(turn, turn.promptText);
      this.turn = turn;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTools(turn, "failed");
      this.item(errorItem(`${turn.id}:error`, message));
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "failed",
        error: { message, code: "SPAWN_ERROR" },
      });
      return true;
    }
  }

  /** A turn without `turn_end` still completes when DSH exited cleanly after `final`. */
  private exitFailure(turn: Turn, exit: TurnExit): ProviderError | null {
    const ended = `${exit.code === null ? exit.signal : `code ${exit.code}`}`;
    const stderr = meaningfulStderr(exit.stderr);
    if (turn.finalText === null)
      return {
        message: diagnostic(stderr || `DSH ended the turn without a final event (exit ${ended})`),
        code: "INCOMPLETE_STREAM",
      };
    if (exit.code !== 0 && exit.code !== null)
      return {
        message: diagnostic(stderr || `DSH exited with ${ended}`),
        code: "PROCESS_EXIT",
      };
    return null;
  }

  private finishTools(turn: Turn, status: "completed" | "failed" | "canceled"): void {
    for (const [callId, record] of turn.tools) {
      if (record.item.status !== "running") continue;
      const updated = toolResultItem(record, {
        status,
        ...(status === "failed" ? { error: "DSH turn failed" } : {}),
      });
      turn.tools.set(callId, updated);
      this.item(updated.item);
    }
  }

  private get selectedModel(): string | undefined {
    return this.config.model ?? this.options.catalog().defaultModel;
  }

  private async writePatch(): Promise<void> {
    const selection = resolveSelection(this.config, this.options.catalog());
    const disabled = disabledPluginsOf(this.config);
    const yaml = patchYaml(selection, disabled);
    if (!yaml) {
      await this.removePatch();
      return;
    }
    if (this.patch === null) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-dsh-"));
      await chmod(directory, 0o700);
      this.patch = { directory, file: path.join(directory, "session.patch.yml") };
    }
    await writeFile(this.patch.file, yaml, { mode: 0o600 });
    await chmod(this.patch.file, 0o600);
  }

  private async removePatch(): Promise<void> {
    if (this.patch === null) return;
    const { directory } = this.patch;
    this.patch = null;
    await rm(directory, { recursive: true, force: true });
  }

  private persistence(): ProviderPersistence {
    if (this.nativeSessionId === null) throw new DshError("DSH has no session yet", "NO_SESSION");
    return { version: 1, data: { sessionId: this.nativeSessionId } };
  }

  private publishConfig(): void {
    const catalog = this.options.catalog();
    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
        ...(this.config.thinkingOption === undefined
          ? {}
          : { thinkingOption: this.config.thinkingOption }),
        models: catalog.models,
        modes: catalog.modes,
        thinkingOptions: catalog.thinkingOptions ?? [],
        settings: [],
      },
    });
  }

  private item(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }

  private emit(event: ProviderEvent): void {
    this.options.emit(event);
  }
}
