/**
 * OpenAI Responses SSE -> canonical stream events (target parse, §13.3).
 *
 * Two independent lifecycles (§13.1): item lifecycle
 * (output_item.added -> ... -> output_item.done) and content lifecycle
 * (content_part.added -> delta* -> content_part.done). `output_item.added
 * (message)` alone does NOT emit text_start; text starts only on
 * content_part.added(output_text) / the first output_text.delta.
 *
 * canonical `index` = the target output item's output_index; content_index /
 * summary_index live in the multi-level `location` (v0.4 P1-10).
 */
import type { CanonicalStreamEvent } from "../types.js";
import type { SSEFrame } from "../sse-parser.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { TranslationWarning } from "../../ir/fidelity.js";

type ItemType = "message" | "reasoning" | "function" | "custom";

interface ItemState {
  itemId: string;
  outputIndex: number;
  type: ItemType;
  /** canonical start event emitted (tool/reasoning/text). */
  started: boolean;
  /** canonical end event emitted. */
  ended: boolean;
  /** message item: open content parts (content_index -> part kind). */
  parts: Map<number, "output_text" | "refusal">;
  /** reasoning item: open summary parts (summary_index). */
  summaryParts: Set<number>;
  /** reasoning item: open reasoning-text content parts (content_index). */
  reasoningParts: Set<number>;
}

export function createResponsesStreamParser(
  _profile: ProviderProfile,
  report?: (warning: TranslationWarning) => void,
): TransformStream<SSEFrame, CanonicalStreamEvent> {
  let messageStarted = false;
  let messageEnded = false;
  let errored = false;
  const items = new Map<string, ItemState>();
  let responseId: string | undefined;
  let model: string | undefined;

  function enqueue(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    event: CanonicalStreamEvent,
  ): void {
    controller.enqueue(event);
  }

  function onLifecycle(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: "created" | "queued" | "in_progress",
    data: Record<string, unknown>,
  ): void {
    if (!messageStarted) {
      messageStarted = true;
      const response = (data.response ?? {}) as { id?: unknown; model?: unknown };
      responseId = typeof response.id === "string" ? response.id : responseId;
      model = typeof response.model === "string" ? response.model : model;
      enqueue(controller, {
        type: "message_start",
        id: responseId,
        model,
      });
      return;
    }
    // Additive lifecycle continuation (v0.5 P1-1): never a second message_start.
    enqueue(controller, { type: "response_state", state });
  }

  function openItem(
    data: Record<string, unknown>,
  ): ItemState | undefined {
    const item = (data.item ?? {}) as { id?: unknown; type?: unknown };
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const outputIndex = typeof data.output_index === "number" ? data.output_index : items.size;
    if (!itemId) return undefined;
    let type: ItemType;
    switch (item.type) {
      case "message":
        type = "message";
        break;
      case "reasoning":
        type = "reasoning";
        break;
      case "function_call":
        type = "function";
        break;
      case "custom_tool_call":
        type = "custom";
        break;
      default:
        return undefined;
    }
    const state: ItemState = {
      itemId,
      outputIndex,
      type,
      started: false,
      ended: false,
      parts: new Map(),
      summaryParts: new Set(),
      reasoningParts: new Set(),
    };
    items.set(itemId, state);
    return state;
  }

  function closeItem(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    data: Record<string, unknown>,
  ): void {
    const item = (data.item ?? {}) as { id?: unknown };
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const state = itemId ? items.get(itemId) : undefined;
    if (!state || state.ended) return;
    // close remaining open content parts, then the item itself.
    if (state.type === "message") {
      for (const [contentIndex, kind] of state.parts) {
        if (kind === "output_text") {
          enqueue(controller, {
            type: "text_end",
            index: state.outputIndex,
            kind: "text",
            location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
          });
        } else {
          enqueue(controller, {
            type: "text_end",
            index: state.outputIndex,
            kind: "refusal",
            location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
          });
        }
      }
      state.parts.clear();
    } else if (state.type === "reasoning") {
      for (const summaryIndex of state.summaryParts) {
        enqueue(controller, {
          type: "reasoning_end",
          index: state.outputIndex,
          location: { kind: "summary", outputIndex: state.outputIndex, summaryIndex },
        });
      }
      for (const contentIndex of state.reasoningParts) {
        enqueue(controller, {
          type: "reasoning_end",
          index: state.outputIndex,
          location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
        });
      }
      state.summaryParts.clear();
      state.reasoningParts.clear();
    }
    state.ended = true;
    items.delete(itemId!);
  }

  function closeAllItems(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    for (const state of [...items.values()]) {
      closeItem(controller, { item: { id: state.itemId } });
    }
  }

  function terminal(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    finishReason: CanonicalFinishReason | undefined,
  ): void {
    if (messageEnded || errored) return;
    messageEnded = true;
    closeAllItems(controller);
    enqueue(controller, { type: "message_end", finishReason });
  }

  return new TransformStream<SSEFrame, CanonicalStreamEvent>({
    transform(frame, controller) {
      if (errored || messageEnded) return;
      if (frame.event !== "message" && frame.event !== "") return;
      if (frame.data === "[DONE]") {
        // Responses has no [DONE]; a tolerant close finalizes without reason.
        terminal(controller, undefined);
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        errored = true;
        enqueue(controller, {
          type: "error",
          error: { kind: "stream_protocol", message: "invalid JSON in Responses stream event" },
        });
        return;
      }
      const type = typeof data.type === "string" ? data.type : "";

      switch (type) {
        case "response.created":
          onLifecycle(controller, "created", data);
          return;
        case "response.queued":
          onLifecycle(controller, "queued", data);
          return;
        case "response.in_progress":
          onLifecycle(controller, "in_progress", data);
          return;

        case "response.output_item.added": {
          const state = openItem(data);
          if (!state) {
            report?.({
              code: "unknown_output_item",
              message: `Unknown Responses output item type "${String((data.item as { type?: unknown })?.type)}" skipped`,
              fidelity: "LOSSY",
              field: "output_item.added",
            });
            return;
          }
          if (state.type === "message") {
            // No text_start yet: content starts at content_part.added (§13.1).
            return;
          }
          if (state.type === "reasoning") {
            state.started = true;
            enqueue(controller, {
              type: "reasoning_start",
              index: state.outputIndex,
              location: { kind: "output", outputIndex: state.outputIndex },
            });
            return;
          }
          // function_call / custom_tool_call
          state.started = true;
          const item = data.item as {
            name?: unknown;
            call_id?: unknown;
            id?: unknown;
            input?: unknown;
            arguments?: unknown;
          };
          const callId =
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : `call_${state.outputIndex}`;
          const name = typeof item.name === "string" ? item.name : `tool_${state.outputIndex}`;
          if (state.type === "custom") {
            enqueue(controller, {
              type: "tool_start",
              index: state.outputIndex,
              id: callId,
              name,
              kind: "custom",
              location: { kind: "output", outputIndex: state.outputIndex },
            });
          } else {
            enqueue(controller, {
              type: "tool_start",
              index: state.outputIndex,
              id: callId,
              name,
              kind: "function",
              location: { kind: "output", outputIndex: state.outputIndex },
            });
          }
          return;
        }

        case "response.output_item.done": {
          const item = (data.item ?? {}) as { id?: unknown };
          const itemId = typeof item.id === "string" ? item.id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state) return;
          if (state.type === "reasoning") {
            if (state.started && !state.ended) {
              for (const summaryIndex of state.summaryParts) {
                enqueue(controller, {
                  type: "reasoning_end",
                  index: state.outputIndex,
                  metadata: { summaryIndex },
                  location: { kind: "summary", outputIndex: state.outputIndex, summaryIndex },
                });
              }
              for (const contentIndex of state.reasoningParts) {
                enqueue(controller, {
                  type: "reasoning_end",
                  index: state.outputIndex,
                  metadata: { contentIndex },
                  location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
                });
              }
              state.summaryParts.clear();
              state.reasoningParts.clear();
              state.ended = true;
              items.delete(itemId!);
            }
            return;
          }
          if (state.type === "message") {
            if (!state.started) return;
            // text_end is emitted per open part; item done closes them.
            for (const [contentIndex, kind] of state.parts) {
              enqueue(controller, {
                type: "text_end",
                index: state.outputIndex,
                kind: kind === "output_text" ? "text" : "refusal",
                location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
              });
            }
            state.parts.clear();
            state.ended = true;
            items.delete(itemId!);
            return;
          }
          // function/custom: close the tool block (arguments already done).
          if (state.started && !state.ended) {
            state.ended = true;
            enqueue(controller, {
              type: "tool_end",
              index: state.outputIndex,
              location: { kind: "output", outputIndex: state.outputIndex },
            });
            items.delete(itemId!);
          }
          return;
        }

        case "response.content_part.added": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "message") return;
          const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
          const partType = (data.part as { type?: unknown })?.type;
          const kind = partType === "refusal" ? "refusal" : "output_text";
          state.parts.set(contentIndex, kind);
          if (!state.started) {
            state.started = true;
            enqueue(controller, {
              type: kind === "refusal" ? "text_start" : "text_start",
              index: state.outputIndex,
              kind: kind === "refusal" ? "refusal" : "text",
              location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
            });
          } else {
            enqueue(controller, {
              type: "text_start",
              index: state.outputIndex,
              kind: kind === "refusal" ? "refusal" : "text",
              location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
            });
          }
          return;
        }
        case "response.content_part.done": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "message") return;
          const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
          const kind = state.parts.get(contentIndex);
          state.parts.delete(contentIndex);
          if (kind === "refusal") {
            enqueue(controller, {
              type: "text_end",
              index: state.outputIndex,
              kind: "refusal",
              location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
            });
          } else {
            enqueue(controller, {
              type: "text_end",
              index: state.outputIndex,
              kind: "text",
              location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
            });
          }
          return;
        }

        case "response.output_text.delta":
        case "response.refusal.delta": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "message") return;
          const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
          const kind = type === "response.refusal.delta" ? "refusal" : "text";
          const text = typeof data.delta === "string" ? data.delta : "";
          // Lazy text_start on first delta (some providers skip content_part.added).
          if (!state.started) {
            state.started = true;
            state.parts.set(contentIndex, kind === "refusal" ? "refusal" : "output_text");
            enqueue(controller, {
              type: "text_start",
              index: state.outputIndex,
              kind,
              location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
            });
          }
          enqueue(controller, {
            type: "text_delta",
            index: state.outputIndex,
            text,
            kind,
            location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
          });
          return;
        }

        case "response.reasoning_summary_part.added": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "reasoning") return;
          const summaryIndex = typeof data.summary_index === "number" ? data.summary_index : 0;
          state.summaryParts.add(summaryIndex);
          return;
        }
        case "response.reasoning_summary_text.delta": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "reasoning") return;
          const summaryIndex = typeof data.summary_index === "number" ? data.summary_index : 0;
          if (!state.summaryParts.has(summaryIndex)) state.summaryParts.add(summaryIndex);
          enqueue(controller, {
            type: "reasoning_delta",
            index: state.outputIndex,
            text: typeof data.delta === "string" ? data.delta : "",
            kind: "summary",
            summaryIndex,
            location: { kind: "summary", outputIndex: state.outputIndex, summaryIndex },
          });
          return;
        }
        case "response.reasoning_summary_text.done":
        case "response.reasoning_summary_part.done": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "reasoning") return;
          const summaryIndex = typeof data.summary_index === "number" ? data.summary_index : 0;
          state.summaryParts.delete(summaryIndex);
          return;
        }
        case "response.reasoning_text.delta": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "reasoning") return;
          const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
          if (!state.reasoningParts.has(contentIndex)) state.reasoningParts.add(contentIndex);
          enqueue(controller, {
            type: "reasoning_delta",
            index: state.outputIndex,
            text: typeof data.delta === "string" ? data.delta : "",
            kind: "text",
            location: { kind: "content", outputIndex: state.outputIndex, contentIndex },
          });
          return;
        }
        case "response.reasoning_text.done": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || state.type !== "reasoning") return;
          const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
          state.reasoningParts.delete(contentIndex);
          return;
        }

        case "response.function_call_arguments.delta":
        case "response.custom_tool_call_input.delta": {
          const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
          const state = itemId ? items.get(itemId) : undefined;
          if (!state || (state.type !== "function" && state.type !== "custom")) return;
          enqueue(controller, {
            type: "tool_arguments_delta",
            index: state.outputIndex,
            partialJson: typeof data.delta === "string" ? data.delta : "",
            location: { kind: "tool", outputIndex: state.outputIndex, toolIndex: 0 },
          });
          return;
        }

        case "response.completed": {
          terminal(controller, hasToolItems(items) ? "tool_call" : "end_turn");
          return;
        }
        case "response.incomplete": {
          terminal(controller, "max_tokens");
          return;
        }
        case "response.failed": {
          if (messageEnded) return;
          errored = true;
          messageEnded = true;
          closeAllItems(controller);
          const response = (data.response ?? {}) as { error?: unknown };
          const err = response.error as { message?: unknown; code?: unknown } | undefined;
          enqueue(controller, {
            type: "error",
            error: {
              kind: "upstream",
              message:
                typeof err?.message === "string"
                  ? err.message
                  : "upstream generation failure",
              providerCode: typeof err?.code === "string" ? err.code : undefined,
            },
          });
          return;
        }
        case "response.cancelled": {
          // Only terminal when the profile declares the SSE event (v0.3 P1-9).
          if (_profile.capabilities.responses?.terminalEvents?.cancelled) {
            if (messageEnded) return;
            errored = true;
            messageEnded = true;
            closeAllItems(controller);
            enqueue(controller, {
              type: "error",
              error: { kind: "cancelled", message: "Response cancelled by upstream" },
            });
          } else {
            report?.({
              code: "cancelled_not_sss_event",
              message:
                "response.cancelled SSE event not declared by the profile; ignored",
              fidelity: "COMPATIBLE",
              field: "response.cancelled",
            });
          }
          return;
        }

        default:
          enqueue(controller, {
            type: "unknown",
            sourceType: type,
            raw: data,
          });
          return;
      }
    },
    flush(controller) {
      if (errored || messageEnded) return;
      report?.({
        code: "stream_closed_without_terminal",
        message: "Responses stream closed without a terminal event; finalized on EOF",
        fidelity: "COMPATIBLE",
        field: "stream",
      });
      terminal(controller, undefined);
    },
  });
}

function hasToolItems(items: Map<string, ItemState>): boolean {
  for (const state of items.values()) {
    if (state.type === "function" || state.type === "custom") return true;
  }
  return false;
}
