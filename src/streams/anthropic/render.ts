/**
 * Canonical stream events -> Anthropic Messages SSE (source render).
 *
 * Renders the canonical event stream into the official Anthropic event
 * sequence so the Anthropic JS SDK can parse it. Index spaces are remapped
 * from (kind, sourceIndex) to Anthropic's global content-block index in arrival
 * order (TH-006 keeps reasoning/tool/text interleaving intact).
 */
import type { CanonicalStreamEvent } from "../types.js";
import { encodeSSE } from "../sse-parser.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { TranslationWarning } from "../../ir/fidelity.js";

type BlockKind = "text" | "tool" | "reasoning";

const STOP_REASON_MAP: Partial<Record<CanonicalFinishReason, string>> = {
  end_turn: "end_turn",
  tool_call: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  refusal: "refusal",
};

export function createAnthropicStreamRenderer(
  report?: (warning: TranslationWarning) => void,
): TransformStream<CanonicalStreamEvent, Uint8Array> {
  const indexMap = new Map<string, number>();
  let nextIndex = 0;
  let started = false;
  let ended = false;
  let terminal = false;
  let cachedUsage: CanonicalUsage | undefined;

  function outputIndex(kind: BlockKind, sourceIndex: number): number {
    const key = `${kind}:${sourceIndex}`;
    let out = indexMap.get(key);
    if (out === undefined) {
      out = nextIndex++;
      indexMap.set(key, out);
    }
    return out;
  }

  function send(
    controller: TransformStreamDefaultController<Uint8Array>,
    event: string,
    data: unknown,
  ): void {
    controller.enqueue(encodeSSE(event, JSON.stringify(data)));
  }

  return new TransformStream<CanonicalStreamEvent, Uint8Array>({
    transform(event, controller) {
      if (terminal) return;

      switch (event.type) {
        case "message_start": {
          if (started) return;
          started = true;
          send(controller, "message_start", {
            type: "message_start",
            message: {
              id: event.id ?? "msg_" + Math.random().toString(36).slice(2, 10),
              type: "message",
              role: "assistant",
              model: event.model,
              content: [],
              stop_reason: null,
              usage: {},
            },
          });
          return;
        }

        case "text_start": {
          const index = outputIndex("text", event.index);
          send(controller, "content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          return;
        }
        case "text_delta": {
          const index = outputIndex("text", event.index);
          send(controller, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: event.text },
          });
          return;
        }
        case "text_end": {
          const index = outputIndex("text", event.index);
          send(controller, "content_block_stop", {
            type: "content_block_stop",
            index,
          });
          return;
        }

        case "tool_start": {
          const index = outputIndex("tool", event.index);
          send(controller, "content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
          });
          return;
        }
        case "tool_arguments_delta": {
          const index = outputIndex("tool", event.index);
          send(controller, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: event.partialJson },
          });
          return;
        }
        case "tool_end": {
          const index = outputIndex("tool", event.index);
          send(controller, "content_block_stop", {
            type: "content_block_stop",
            index,
          });
          return;
        }

        case "reasoning_start": {
          const index = outputIndex("reasoning", event.index);
          const signature =
            (event.metadata as { signature?: unknown } | undefined)?.signature;
          send(controller, "content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "thinking",
              thinking: "",
              ...(typeof signature === "string" ? { signature } : {}),
            },
          });
          return;
        }
        case "reasoning_delta": {
          const index = outputIndex("reasoning", event.index);
          if (event.text !== undefined) {
            send(controller, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: event.text },
            });
          } else if (event.opaque !== undefined) {
            send(controller, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: event.opaque },
            });
          }
          return;
        }
        case "reasoning_end": {
          const index = outputIndex("reasoning", event.index);
          send(controller, "content_block_stop", {
            type: "content_block_stop",
            index,
          });
          return;
        }

        case "usage":
          // Folded into the final message_delta; never emitted separately so
          // the Anthropic SDK sees exactly one terminal message_delta.
          cachedUsage = event.usage;
          return;

        case "message_end": {
          if (ended) return;
          ended = true;
          terminal = true;
          if (event.finishReason === "content_filter") {
            report?.({
              code: "stop_reason_lossy",
              message: "content_filter stop reason mapped to end_turn for Anthropic stream",
              fidelity: "LOSSY",
              field: "finishReason",
            });
          }
          // Anthropic protocol mandates usage on message_delta and the official
          // SDK reads it unconditionally; missing upstream counts render as 0
          // (structural requirement, not fabricated billing data).
          send(controller, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: renderStopReason(event.finishReason) },
            usage: renderUsage(cachedUsage ?? {}),
          });
          return;
        }

        case "error": {
          if (ended) return;
          terminal = true;
          send(controller, "error", {
            type: "error",
            error: {
              type: "api_error",
              message: event.error.message,
            },
          });
          return;
        }

        case "unknown":
          return;
      }
    },
    flush(controller) {
      // Stream ended without a terminal transition: emit a safe end with the
      // protocol-mandated usage structure.
      if (!terminal) {
        send(controller, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: null },
          usage: renderUsage(cachedUsage ?? {}),
        });
      }
      send(controller, "message_stop", { type: "message_stop" });
    },
  });
}

function renderStopReason(reason: CanonicalFinishReason | undefined): string | null {
  if (reason === undefined) return null;
  if (reason === "content_filter") return "end_turn";
  return STOP_REASON_MAP[reason] ?? null;
}

function renderUsage(usage: CanonicalUsage): Record<string, unknown> {
  return {
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationTokens }
      : {}),
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
  };
}
