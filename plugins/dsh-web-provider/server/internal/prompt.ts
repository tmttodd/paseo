import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

/**
 * Paseo prompt content → DSH `session/prompt` content blocks.
 *
 * DSH accepts text, images and uploaded-file receipts. Everything else Paseo
 * can attach (reviews, forge PR/issue context, text attachments) is already
 * plain data, so it rides as text rather than being dropped.
 */
export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string };

export function encodeContent(prompt: ProviderPrompt): DshContentBlock[] {
  if (prompt.input.type !== "message") {
    throw new Error("encodeContent only handles message prompts");
  }
  const blocks: DshContentBlock[] = [];
  for (const part of prompt.input.content) {
    if (part.type === "text") {
      if ("mimeType" in part) {
        const text = encodePart(part);
        if (text.trim().length > 0) blocks.push({ type: "text", text });
      } else if (part.text.trim().length > 0) {
        blocks.push({ type: "text", text: part.text });
      }
      continue;
    }
    if (part.type === "image") {
      blocks.push({
        type: "image",
        mediaType: part.mimeType,
        data: part.data,
      });
      continue;
    }
    const text = encodePart(part as Exclude<ProviderContent, { type: "text" } | { type: "image" }>);
    if (text.trim().length > 0) blocks.push({ type: "text", text });
  }
  return blocks;
}

function encodePart(part: ProviderContent): string {
  switch (part.type) {
    case "text":
      return encodeTextAttachment(
        part as Extract<ProviderContent, { type: "text"; mimeType: "text/plain" }>,
      );
    case "uploaded_file":
      return `[uploaded file: ${part.fileName} (${part.mimeType}, ${String(part.size)} bytes) at ${part.path}]`;
    case "review":
      return encodeReview(part);
    case "forge_change_request":
    case "forge_issue":
    case "github_pr":
    case "github_issue":
      return encodeIssue(part);
    default:
      return `[attachment: ${(part as { type: string }).type}]`;
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
  const lines = [`## ${kind} #${String(part.number)}: ${part.title}`, part.url];
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
    lines.push(
      "",
      `### ${comment.filePath}:${String(comment.lineNumber)} (${comment.side})`,
      comment.body,
    );
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
