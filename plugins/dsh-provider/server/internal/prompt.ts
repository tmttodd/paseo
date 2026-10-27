import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { DshError } from "./wire.js";

/**
 * DSH headless takes its turn as a single argv string, so every prompt part has
 * to become text. Attachments that carry a body are inlined; files that live on
 * disk are referenced by path because DSH's own tools can read them.
 */
export function encodePrompt(prompt: ProviderPrompt): string {
  if (prompt.delivery === "steer")
    throw new DshError("DSH runs one process per turn and cannot steer", "UNSUPPORTED_STEER");
  if (prompt.input.type !== "message")
    throw new DshError("DSH does not support Paseo commands", "UNSUPPORTED_COMMAND");
  if (prompt.outputSchema !== undefined)
    throw new DshError("DSH has no structured output mode", "UNSUPPORTED_OUTPUT_SCHEMA");
  const text = prompt.input.content
    .map(encodePart)
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (text.trim().length === 0)
    throw new DshError("The prompt has no text content DSH can receive", "EMPTY_PROMPT");
  return text;
}

/** Paseo's system prompt rides along with the first turn only; DSH keeps session state. */
export function composeTaskText(options: { systemPrompt?: string; text: string }): string {
  const preamble = options.systemPrompt?.trim();
  if (!preamble) return options.text;
  return `<paseo_session_context>\n${preamble}\n</paseo_session_context>\n\n${options.text}`;
}

function encodePart(part: ProviderContent): string {
  switch (part.type) {
    case "text":
      if ("mimeType" in part) return encodeTextAttachment(part);
      return part.text;
    case "image":
      // Not advertised as a capability; keep the turn honest if one arrives anyway.
      return `[image attachment omitted: DSH's headless CLI cannot receive ${part.mimeType} images]`;
    case "uploaded_file":
      return `[uploaded file: ${part.fileName} (${part.mimeType}, ${part.size} bytes) at ${part.path}]`;
    case "review":
      return encodeReview(part);
    case "forge_change_request":
    case "forge_issue":
    case "github_pr":
    case "github_issue":
      return encodeIssue(part);
    default:
      throw new DshError(
        `DSH cannot receive ${(part as { type: string }).type} content`,
        "UNSUPPORTED_CONTENT",
      );
  }
}

function encodeTextAttachment(
  part: Extract<ProviderContent, { type: "text"; mimeType: "text/plain" }>,
): string {
  const heading = part.title ? `## ${part.title}\n\n` : "";
  const source = part.externalResource ? `\n\nSource: ${part.externalResource.url}` : "";
  return `${heading}${part.text}${source}`;
}

function encodeIssue(
  part:
    | Extract<ProviderContent, { type: "github_pr" }>
    | Extract<ProviderContent, { type: "github_issue" }>
    | Extract<ProviderContent, { type: "forge_change_request" }>
    | Extract<ProviderContent, { type: "forge_issue" }>,
): string {
  const kind = part.type === "github_pr" || part.type === "forge_change_request" ? "PR" : "Issue";
  const lines = [`## ${kind} #${part.number}: ${part.title}`, part.url];
  if ("baseRefName" in part && part.baseRefName) lines.push(`Base: ${part.baseRefName}`);
  if ("headRefName" in part && part.headRefName) lines.push(`Head: ${part.headRefName}`);
  if (part.body) lines.push("", part.body);
  return lines.join("\n");
}

function encodeReview(part: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [
    `## Code review (${part.mode === "uncommitted" ? "uncommitted changes" : `base ${part.baseRef ?? "HEAD"}`})`,
    `Working directory: ${part.cwd}`,
  ];
  for (const comment of part.comments) {
    lines.push("", `### ${comment.filePath}:${comment.lineNumber} (${comment.side})`, comment.body);
    lines.push("```", comment.context.hunkHeader);
    for (const line of comment.context.lines) {
      let marker = " ";
      if (line.type === "add") marker = "+";
      else if (line.type === "remove") marker = "-";
      lines.push(`${marker}${line.content}`);
    }
    lines.push("```");
  }
  return lines.join("\n");
}
