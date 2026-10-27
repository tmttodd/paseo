import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

/** JSON value as the provider contract models it. */
type Json = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

export type ToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

export interface ToolRecord {
  item: ToolCallItem;
  tool: string;
  input: Json;
}

export function userMessageItem(options: {
  id: string;
  clientMessageId: string;
  text: string;
}): ProviderTimelineItem {
  return {
    type: "user_message",
    id: options.id,
    clientMessageId: options.clientMessageId,
    text: options.text,
  };
}

export function assistantMessageItem(id: string, text: string): ProviderTimelineItem {
  return { type: "assistant_message", id, messageId: id, text };
}

export function reasoningItem(id: string, text: string): ProviderTimelineItem {
  return { type: "reasoning", id, text };
}

export function errorItem(id: string, message: string): ProviderTimelineItem {
  return { type: "error", id, message };
}

export function toolCallItem(options: {
  id: string;
  callId: string;
  tool: string;
  input: Json;
}): ToolRecord {
  return {
    tool: options.tool,
    input: options.input,
    item: {
      type: "tool_call",
      id: options.id,
      callId: options.callId,
      name: options.tool,
      detail: toolDetail(options.tool, options.input),
      status: "running",
      error: null,
    },
  };
}

export function toolResultItem(
  record: ToolRecord,
  options: { status: "completed" | "failed" | "canceled"; output?: string; error?: string },
): ToolRecord {
  const detail = toolDetail(record.tool, record.input, options.output);
  const base = { ...record.item, detail };
  if (options.status === "failed")
    return {
      ...record,
      item: {
        ...base,
        status: "failed",
        error: options.error ?? options.output ?? "DSH tool failed",
      },
    };
  return { ...record, item: { ...base, status: options.status, error: null } };
}

/** Map a DSH tool call onto the richest detail Paseo knows how to render. */
export function toolDetail(tool: string, input: Json, output?: string): ProviderToolCallDetail {
  const fields = asObject(input);
  if (!fields) return { type: "unknown", input, output: output ?? "" };
  const name = tool.toLowerCase();
  const command = stringField(fields, ["command", "cmd", "script"]);
  if (command) {
    const cwd = stringField(fields, ["cwd", "workdir", "workingDirectory"]);
    return cwd === undefined
      ? { type: "shell", command, output }
      : { type: "shell", command, cwd, output };
  }
  const filePath = stringField(fields, [
    "filePath",
    "file_path",
    "path",
    "target_file",
    "filename",
  ]);
  if (filePath) {
    if (/write|create|save/.test(name)) return { type: "write", filePath, content: output };
    if (/edit|patch|replace|apply/.test(name)) return { type: "edit", filePath };
    if (/read|view|cat|open|show/.test(name)) return { type: "read", filePath, content: output };
  }
  const query = stringField(fields, ["query", "pattern", "search", "q"]);
  if (query) {
    return { type: "search", query, toolName: searchToolName(name), content: output };
  }
  const url = stringField(fields, ["url", "uri", "href"]);
  if (url) return { type: "fetch", url, result: output };
  return { type: "unknown", input, output: output ?? "" };
}

/** Which search affordance the composer row shows for a provider tool name. */
function searchToolName(name: string): "grep" | "glob" | "web_search" | "search" {
  if (/grep/.test(name)) return "grep";
  if (/glob/.test(name)) return "glob";
  if (/web|http/.test(name)) return "web_search";
  return "search";
}

export function resultText(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function asObject(value: Json): Record<string, Json> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function stringField(fields: Record<string, Json>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
