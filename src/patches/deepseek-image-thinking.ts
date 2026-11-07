/**
 * DeepSeek image `tool_result` thinking patch.
 *
 * Some DeepSeek Anthropic-compatible channels run thinking mode and reject a
 * history whose assistant message issued a `tool_use` answered by a tool result
 * containing an image, unless that same assistant message also carries a
 * non-empty `thinking` block (400: "The content[].thinking in the thinking mode
 * must be passed back to the API."). Clients that keep reasoning as plain text
 * never send such a block, so text-only tool loops keep working while the first
 * image read fails.
 *
 * The patch inserts a placeholder `thinking` block into exactly those assistant
 * messages: an image-bearing `tool_result` answers a `tool_use` from the
 * preceding assistant message, and that message has no usable thinking block.
 * Histories without images, or with a `thinking` / `redacted_thinking` block,
 * are returned unchanged. The patch is gated on the target model: only model
 * ids whose prefix is `deepseek` are processed, so it can be enabled globally
 * and still skip real Anthropic (or any other provider) traffic.
 *
 * Opt-in: nothing runs unless the patch is passed in `patches`.
 */
import type { RequestPatch } from "./request-patch.js";

/** Text sent in the synthesized block; any non-empty string satisfies the API. */
export const IMAGE_THINKING_PLACEHOLDER = "[thinking omitted by the client]";

export const deepseekImageThinkingPatch: RequestPatch = {
  filter: (request) => isDeepseekModel(request.model),
  apply: injectImageThinking,
};

/** Whether the rendered target body addresses a DeepSeek model. */
function isDeepseekModel(model: unknown): boolean {
  return typeof model === "string" && model.trim().toLowerCase().startsWith("deepseek");
}

function injectImageThinking(
  request: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const messages = request.messages;
  if (!Array.isArray(messages)) return { ...request };

  const patched = messages.map((raw, index) => {
    const message = asRecord(raw);
    if (message === undefined || message.role !== "assistant") return raw;
    const content = message.content;
    if (!Array.isArray(content)) return raw;

    const toolUseIds = new Set<string>();
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type === "tool_use" && typeof record.id === "string") {
        toolUseIds.add(record.id);
      }
    }
    if (toolUseIds.size === 0 || hasUsableThinking(content)) return raw;
    if (!hasImageToolResult(messages[index + 1], toolUseIds)) return raw;

    return {
      ...message,
      content: [
        { type: "thinking", thinking: IMAGE_THINKING_PLACEHOLDER },
        // A blank thinking block is rejected on its own, so it is replaced
        // rather than duplicated.
        ...content.filter((block) => !isBlankThinking(block)),
      ],
    };
  });

  return { ...request, messages: patched };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasUsableThinking(content: readonly unknown[]): boolean {
  return content.some((block) => {
    const record = asRecord(block);
    if (record?.type === "redacted_thinking") return true;
    return (
      record?.type === "thinking" &&
      typeof record.thinking === "string" &&
      record.thinking.trim() !== ""
    );
  });
}

function isBlankThinking(block: unknown): boolean {
  const record = asRecord(block);
  if (record?.type !== "thinking") return false;
  return typeof record.thinking !== "string" || record.thinking.trim() === "";
}

function hasImageToolResult(raw: unknown, toolUseIds: ReadonlySet<string>): boolean {
  const message = asRecord(raw);
  if (message?.role !== "user" || !Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    const record = asRecord(block);
    if (record?.type !== "tool_result") return false;
    if (typeof record.tool_use_id !== "string" || !toolUseIds.has(record.tool_use_id)) {
      return false;
    }
    return (
      Array.isArray(record.content) &&
      record.content.some((item) => asRecord(item)?.type === "image")
    );
  });
}
