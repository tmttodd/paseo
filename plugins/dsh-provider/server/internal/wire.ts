import { z } from "zod";

/**
 * Wire contract for `dsh --json`.
 *
 * DSH writes one JSON object per line to stdout and diagnostics to stderr. The
 * vocabulary below is the verified subset (real captures in `test/fixtures/real`).
 * Fields are parsed permissively so a newer DSH that adds phases, statuses, or
 * fields keeps working; unknown *event types* are skipped rather than fatal.
 */
const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative().default(0),
    outputTokens: z.number().nonnegative().default(0),
    totalTokens: z.number().nonnegative().default(0),
    cacheReadTokens: z.number().nonnegative().default(0),
  })
  .strip();

export type DshUsage = z.infer<typeof usageSchema>;

const reasonSchema = z
  .object({
    kind: z.string().min(1),
    error: z.object({ message: z.string(), code: z.string().optional() }).strip().optional(),
  })
  .strip();

const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session"),
      sessionId: z.string().min(1),
      cwd: z.string().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("status"),
      phase: z.string().min(1),
      turn: z.number().int().nonnegative().optional(),
      step: z.number().int().nonnegative().optional(),
      usage: usageSchema.optional(),
      reason: reasonSchema.optional(),
    })
    .strip(),
  z.object({ type: z.literal("thinking"), text: z.string() }).strip(),
  z.object({ type: z.literal("text"), text: z.string() }).strip(),
  z
    .object({
      type: z.literal("tool_call"),
      callId: z.string().min(1),
      tool: z.string().min(1),
      input: z.json().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("tool_result"),
      callId: z.string().min(1),
      status: z.string().optional(),
      result: z.json().optional(),
      error: z.json().optional(),
    })
    .strip(),
  z.object({ type: z.literal("final"), text: z.string() }).strip(),
  // DSH answers a rejected invocation with this shape instead of a turn stream, e.g.
  // `{"type":"error","message":"unknown option '--patch'"}` or a missing session id.
  z.object({ type: z.literal("error"), message: z.string() }).strip(),
]);

export type DshEvent = z.infer<typeof eventSchema>;
export type DshStatus = Extract<DshEvent, { type: "status" }>;
export type DshToolCall = Extract<DshEvent, { type: "tool_call" }>;
export type DshToolResult = Extract<DshEvent, { type: "tool_result" }>;
export type DshSessionEvent = Extract<DshEvent, { type: "session" }>;

const knownTypes: Readonly<Record<string, true>> = {
  session: true,
  status: true,
  thinking: true,
  text: true,
  tool_call: true,
  tool_result: true,
  final: true,
  error: true,
};

/**
 * Decode one stdout line. Blank lines and event types this build does not know
 * are ignored; malformed JSON or a malformed known event is a protocol failure.
 */
export function decodeEvent(line: string): DshEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new DshError(
      `DSH wrote a non-JSON line to stdout: ${preview(trimmed)}`,
      "INVALID_STREAM",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DshError(`DSH wrote a non-object event: ${preview(trimmed)}`, "INVALID_STREAM");
  if (!("type" in value) || typeof value.type !== "string")
    throw new DshError(`DSH event has no type: ${preview(trimmed)}`, "INVALID_STREAM");
  const type = value.type;
  if (!knownTypes[type]) return null;
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success)
    throw new DshError(
      `DSH sent a malformed ${type} event: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      "INVALID_STREAM",
    );
  return parsed.data;
}

export class DshError extends Error {
  constructor(
    message: string,
    readonly code = "DSH_ERROR",
  ) {
    super(message);
    this.name = "DshError";
  }
}

/** Turn the common DSH failures into something an operator can act on. */
export function diagnostic(message: string): string {
  const text = message.trim();
  if (!text) return "DSH failed without a diagnostic";
  if (/enoent|not found/i.test(text))
    return "dsh was not found on PATH. Install the DeepSeek Harness CLI, then run `dsh --version`.";
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api key/i.test(text))
    return `DSH could not authenticate with its model provider: ${text}`;
  if (/no such profile|unknown profile|profile .* not found/i.test(text))
    return `DSH profile is missing: ${text}`;
  return text;
}

function preview(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/**
 * Profile activation noise every DSH run writes to stderr (about 4 KB): rows whose
 * plugin is still waiting for a service it never gets in a non-interactive profile.
 * It is not a failure cause, and it must not become the turn's error message.
 */
const STDERR_NOISE = [
  /^dsh: warning: \d+ entries? did not activate$/,
  /^[a-z0-9-]+ \(@deepseek-ai\/[a-z0-9-]+\): pending \(waiting for service: [a-z0-9]+\)$/i,
  /^tool-subagent-specialist \(@deepseek-ai\/dsh-tool-subagent\): Error: tool-subagent: agent preset selection requires the agent-presets service$/,
  /^\s+at .*(?:dsh-tool-subagent|cordis|#include|#tool-subagent-specialist)/,
];

/** Drop profile activation noise, keeping every line that could explain a failure. */
export function meaningfulStderr(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() && !STDERR_NOISE.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
}

/**
 * DSH's answer when the persisted session id is gone:
 * `session "session-…" does not exist; omit --session-id to start a new Session`.
 */
export function isStaleSessionError(message: string): boolean {
  return /session\b.*\bdoes not exist/i.test(message);
}
