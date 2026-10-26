/**
 * Optional feature `redact-output`: rewrites credential-shaped values in tool results before they
 * reach the transcript. One-way and best-effort (see redact.ts). Off by default because it changes
 * what every tool shows the model.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { redactText } from "./redact";

interface TextChunk {
  type: "text";
  text: string;
}

function isTextChunk(chunk: unknown): chunk is TextChunk {
  if (typeof chunk !== "object" || chunk === null) return false;
  if (!("type" in chunk) || !("text" in chunk)) return false;
  return chunk.type === "text" && typeof chunk.text === "string";
}

// Only dynamic command/execution output is redacted. Reading source (read/grep/glob/find) is left
// untouched: redacting code corrupts what the agent sees and breaks edit old_string matching.
const REDACTED_TOOLS: Record<string, true> = { bash: true, eval: true };

export default function redactOutput(pi: ExtensionAPI): void {
  pi.on("tool_result", event => {
    if (!REDACTED_TOOLS[event.toolName]) return;
    const content: unknown = event.content;
    if (!Array.isArray(content)) return;
    let changed = false;
    const next = content.map((chunk: unknown) => {
      if (!isTextChunk(chunk)) return chunk;
      const text = redactText(chunk.text);
      if (text !== chunk.text) changed = true;
      return { ...chunk, text };
    });
    if (changed) return { content: next };
  });
}
