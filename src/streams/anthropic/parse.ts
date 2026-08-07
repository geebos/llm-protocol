/**
 * Anthropic Messages SSE -> canonical stream events (target parse).
 *
 * A stateful TransformStream because:
 * - `content_block_stop` carries only an index and needs the block type
 *   recorded at its `content_block_start` (SR-002);
 * - `message_delta` carries usage and stop_reason in one frame but maps to two
 *   canonical events;
 * - `message_stop` may need to synthesize a missing `message_end`.
 */
import type { CanonicalStreamEvent } from "../types.js";
import type { SSEFrame } from "../sse-parser.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { TranslationWarning } from "../../ir/fidelity.js";

type BlockType = "text" | "tool" | "reasoning";

const FINISH_REASON_MAP: Record<string, CanonicalFinishReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  tool_use: "tool_call",
  refusal: "refusal",
};

export function parseAnthropicUsage(usage: unknown): CanonicalUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const parsed: CanonicalUsage = {};
  if (typeof u.input_tokens === "number") parsed.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") parsed.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") {
    parsed.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation_input_tokens === "number") {
    parsed.cacheCreationTokens = u.cache_creation_input_tokens;
  }
  // totalTokens is the additive whole: pure input + cache + output.
  if (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined) {
    parsed.totalTokens =
      parsed.inputTokens +
      (parsed.cacheReadTokens ?? 0) +
      (parsed.cacheCreationTokens ?? 0) +
      parsed.outputTokens;
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

export function createAnthropicStreamParser(
  report?: (warning: TranslationWarning) => void,
): TransformStream<SSEFrame, CanonicalStreamEvent> {
  const blocks = new Map<number, BlockType>();
  let messageEnded = false;

  function enqueue(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    event: CanonicalStreamEvent | null,
  ): void {
    if (event) controller.enqueue(event);
  }

  return new TransformStream<SSEFrame, CanonicalStreamEvent>({
    transform(frame, controller) {
      switch (frame.event) {
        case "ping":
          return;

        case "message_start": {
          const data = safeJson(frame.data) as {
            message?: { id?: unknown; model?: unknown };
          };
          enqueue(controller, {
            type: "message_start",
            id: typeof data.message?.id === "string" ? data.message.id : undefined,
            model:
              typeof data.message?.model === "string" ? data.message.model : undefined,
          });
          return;
        }

        case "content_block_start": {
          const data = safeJson(frame.data) as {
            index?: unknown;
            content_block?: { type?: unknown; id?: unknown; name?: unknown; signature?: unknown };
          };
          const index = typeof data.index === "number" ? data.index : 0;
          switch (data.content_block?.type) {
            case "text":
              blocks.set(index, "text");
              enqueue(controller, { type: "text_start", index });
              return;
            case "tool_use": {
              blocks.set(index, "tool");
              const id =
                typeof data.content_block.id === "string"
                  ? data.content_block.id
                  : null;
              if (!id) {
                // TR-002: synthesize a stable, traceable id and report it.
                report?.({
                  code: "synthesized_tool_id",
                  message: `Synthesized tool_use id "toolu_${index}" for content block index ${index}`,
                  fidelity: "COMPATIBLE",
                  field: `content[${index}].tool_use.id`,
                });
              }
              enqueue(controller, {
                type: "tool_start",
                index,
                id: id ?? `toolu_${index}`,
                name:
                  typeof data.content_block.name === "string"
                    ? data.content_block.name
                    : `tool_${index}`,
              });
              return;
            }
            case "thinking":
              blocks.set(index, "reasoning");
              enqueue(controller, {
                type: "reasoning_start",
                index,
                metadata: {
                  type: "thinking",
                  signature:
                    typeof data.content_block.signature === "string"
                      ? data.content_block.signature
                      : undefined,
                },
              });
              return;
            case "redacted_thinking":
              blocks.set(index, "reasoning");
              enqueue(controller, {
                type: "reasoning_start",
                index,
                metadata: {
                  type: "redacted_thinking",
                  data:
                    typeof (data.content_block as { data?: unknown }).data === "string"
                      ? (data.content_block as { data: string }).data
                      : undefined,
                },
              });
              return;
            default:
              enqueue(controller, {
                type: "unknown",
                sourceType: "content_block_start",
                raw: data,
              });
              return;
          }
        }

        case "content_block_delta": {
          const data = safeJson(frame.data) as {
            index?: unknown;
            delta?: { type?: unknown; text?: unknown; partial_json?: unknown; thinking?: unknown; signature?: unknown };
          };
          const index = typeof data.index === "number" ? data.index : 0;
          switch (data.delta?.type) {
            case "text_delta":
              enqueue(controller, {
                type: "text_delta",
                index,
                text: typeof data.delta.text === "string" ? data.delta.text : "",
              });
              return;
            case "input_json_delta":
              enqueue(controller, {
                type: "tool_arguments_delta",
                index,
                partialJson:
                  typeof data.delta.partial_json === "string" ? data.delta.partial_json : "",
              });
              return;
            case "thinking_delta":
              enqueue(controller, {
                type: "reasoning_delta",
                index,
                text: typeof data.delta.thinking === "string" ? data.delta.thinking : "",
              });
              return;
            case "signature_delta":
              enqueue(controller, {
                type: "reasoning_delta",
                index,
                opaque: typeof data.delta.signature === "string" ? data.delta.signature : "",
              });
              return;
            default:
              enqueue(controller, {
                type: "unknown",
                sourceType: "content_block_delta",
                raw: data,
              });
              return;
          }
        }

        case "content_block_stop": {
          const data = safeJson(frame.data) as { index?: unknown };
          const index = typeof data.index === "number" ? data.index : 0;
          const kind = blocks.get(index);
          if (kind === "text") enqueue(controller, { type: "text_end", index });
          else if (kind === "tool") enqueue(controller, { type: "tool_end", index });
          else if (kind === "reasoning") enqueue(controller, { type: "reasoning_end", index });
          else enqueue(controller, { type: "unknown", sourceType: "content_block_stop", raw: data });
          return;
        }

        case "message_delta": {
          const data = safeJson(frame.data) as {
            delta?: { stop_reason?: unknown };
            usage?: unknown;
          };
          const usage = parseAnthropicUsage(data.usage);
          if (usage) enqueue(controller, { type: "usage", usage });
          const stopReason =
            typeof data.delta?.stop_reason === "string"
              ? (FINISH_REASON_MAP[data.delta.stop_reason] ?? "unknown")
              : undefined;
          messageEnded = true;
          enqueue(controller, { type: "message_end", finishReason: stopReason });
          return;
        }

        case "error": {
          const data = safeJson(frame.data) as {
            error?: { type?: unknown; message?: unknown };
          };
          enqueue(controller, {
            type: "error",
            error: {
              kind: "stream_protocol",
              message:
                typeof data.error?.message === "string"
                  ? data.error.message
                  : "upstream stream error",
              providerCode:
                typeof data.error?.type === "string" ? data.error.type : undefined,
            },
          });
          return;
        }

        case "message_stop":
          if (!messageEnded) {
            enqueue(controller, { type: "message_end" });
          }
          return;

        default:
          enqueue(controller, { type: "unknown", sourceType: frame.event, raw: frame });
          return;
      }
    },
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
