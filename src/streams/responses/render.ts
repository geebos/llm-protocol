/**
 * Canonical stream events -> OpenAI Responses SSE (source render, §13.2).
 *
 * Renders the canonical event stream into the official Responses event
 * sequence (item lifecycle + content lifecycle, §13.1). Adjacent text blocks
 * aggregate into one message item with multiple content parts; interleaved
 * tool/reasoning blocks become independent items (output_index keeps order).
 *
 * The Response Envelope Builder owns id/created_at/status/output/usage; the
 * terminal snapshot (`response.completed` / `response.incomplete`) carries the
 * full envelope so the official SDK can parse it (v0.5 P0-3).
 */
import type { CanonicalStreamEvent } from "../types.js";
import { encodeDataFrame } from "../sse-parser.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import {
  ResponseEnvelopeBuilder,
  envelopeToWire,
} from "../../codecs/openai-responses/envelope.js";

type ToolKind = "function" | "custom";

interface OpenItem {
  itemId: string;
  outputIndex: number;
  type: "message" | "reasoning" | "function" | "custom";
  /** message item: open content parts (content_index -> kind/text). */
  textParts: Array<{ contentIndex: number; kind: "output_text" | "refusal"; text: string }>;
  /** reasoning item: summary parts (summary_index -> text). */
  summaryParts: Map<number, string>;
  /** reasoning item: reasoning-text parts (content_index -> text). */
  reasoningParts: Map<number, string>;
  /** tool item metadata. */
  toolKind?: ToolKind;
  name?: string;
  callId?: string;
  args?: string;
}

export function createResponsesStreamRenderer(
  profile: ProviderProfile,
  report?: (warning: TranslationWarning) => void,
): TransformStream<CanonicalStreamEvent, Uint8Array> {
  let envelope: ResponseEnvelopeBuilder | undefined;
  let sequenceNumber = 0;
  let nextOutputIndex = 0;
  let messageStarted = false;
  let terminal = false;
  let ended = false;
  let lifecycleSent = false;
  let messageItem: OpenItem | undefined;
  let nextContentIndex = 0;
  const toolItems = new Map<number, OpenItem>();
  const reasoningItems = new Map<number, OpenItem>();
  let cachedUsage: CanonicalUsage | undefined;

  function send(
    controller: TransformStreamDefaultController<Uint8Array>,
    data: Record<string, unknown>,
  ): void {
    controller.enqueue(
      encodeDataFrame(JSON.stringify({ sequence_number: sequenceNumber++, ...data })),
    );
  }

  function flushMessageItem(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (!messageItem) return;
    const item = messageItem;
    messageItem = undefined;
    const wire: Record<string, unknown> = {
      id: item.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: item.textParts.map((p) =>
        p.kind === "output_text"
          ? { type: "output_text", text: p.text, annotations: [] }
          : { type: "refusal", refusal: p.text },
      ),
    };
    send(controller, { type: "response.output_item.done", output_index: item.outputIndex, item: wire });
    envelope?.completeItem(item.itemId);
  }

  function flushToolItem(
    controller: TransformStreamDefaultController<Uint8Array>,
    item: OpenItem,
  ): void {
    toolItems.delete(item.outputIndex);
    if (item.toolKind === "custom") {
      send(controller, {
        type: "response.custom_tool_call_input.done",
        item_id: item.itemId,
        output_index: item.outputIndex,
        input: item.args ?? "",
      });
      send(controller, {
        type: "response.output_item.done",
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "custom_tool_call",
          status: "completed",
          name: item.name,
          call_id: item.callId,
          input: item.args ?? "",
        },
      });
    } else {
      send(controller, {
        type: "response.function_call_arguments.done",
        item_id: item.itemId,
        output_index: item.outputIndex,
        arguments: item.args ?? "",
      });
      send(controller, {
        type: "response.output_item.done",
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "function_call",
          status: "completed",
          name: item.name,
          call_id: item.callId,
          arguments: item.args ?? "",
        },
      });
    }
    envelope?.completeItem(item.itemId);
  }

  function flushReasoningItem(
    controller: TransformStreamDefaultController<Uint8Array>,
    item: OpenItem,
  ): void {
    reasoningItems.delete(item.outputIndex);
    const summary = [...item.summaryParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => ({ type: "summary_text", text }));
    const content = [...item.reasoningParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => ({ type: "reasoning_text", text }));
    send(controller, {
      type: "response.output_item.done",
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: "reasoning",
        status: "completed",
        summary,
        content,
      },
    });
    envelope?.completeItem(item.itemId);
  }

  function flushAllItems(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    flushMessageItem(controller);
    for (const item of [...toolItems.values()]) flushToolItem(controller, item);
    for (const item of [...reasoningItems.values()]) flushReasoningItem(controller, item);
  }

  function ensureEnvelope(): ResponseEnvelopeBuilder {
    if (!envelope) {
      envelope = new ResponseEnvelopeBuilder(
        `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        Math.floor(Date.now() / 1000),
      );
    }
    return envelope;
  }

  function sendLifecycle(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (lifecycleSent) return;
    lifecycleSent = true;
    const env = ensureEnvelope();
    const createdWire = envelopeToWire(env.snapshot());
    send(controller, { type: "response.created", response: createdWire });
    // queued only when the profile declares the SSE event (v0.4 P1-9).
    if (profile.capabilities.responses?.terminalEvents?.queued) {
      send(controller, {
        type: "response.queued",
        response: envelopeToWire(env.snapshot()),
      });
    }
    env.setStatus("in_progress");
    send(controller, { type: "response.in_progress", response: envelopeToWire(env.snapshot()) });
  }

  function openMessageItem(
    controller: TransformStreamDefaultController<Uint8Array>,
    kind: "text" | "refusal",
  ): OpenItem {
    if (messageItem) return messageItem;
    const itemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outputIndex = nextOutputIndex++;
    const item: OpenItem = {
      itemId,
      outputIndex,
      type: "message",
      textParts: [],
      summaryParts: new Map(),
      reasoningParts: new Map(),
    };
    messageItem = item;
    nextContentIndex = 0;
    const payload: Record<string, unknown> = {
      role: "assistant",
      content: [],
      ...(kind === "refusal" ? {} : {}),
    };
    send(controller, {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: itemId, type: "message", status: "in_progress", ...payload },
    });
    envelope?.addItem({
      id: itemId,
      type: "message",
      status: "in_progress",
      outputIndex,
      payload,
    });
    return item;
  }

  function openToolItem(
    controller: TransformStreamDefaultController<Uint8Array>,
    index: number,
    id: string,
    name: string,
    kind: ToolKind,
  ): void {
    flushMessageItem(controller);
    const itemId = kind === "custom" ? `ctc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}` : `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outputIndex = nextOutputIndex++;
    const item: OpenItem = {
      itemId,
      outputIndex,
      type: kind === "custom" ? "custom" : "function",
      textParts: [],
      summaryParts: new Map(),
      reasoningParts: new Map(),
      toolKind: kind,
      name,
      callId: id,
      args: "",
    };
    toolItems.set(index, item);
    const payload: Record<string, unknown> =
      kind === "custom"
        ? { name, call_id: id, input: "" }
        : { name, call_id: id, arguments: "" };
    send(controller, {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        id: itemId,
        type: kind === "custom" ? "custom_tool_call" : "function_call",
        status: "in_progress",
        ...payload,
      },
    });
    envelope?.addItem({
      id: itemId,
      type: kind === "custom" ? "custom_tool_call" : "function_call",
      status: "in_progress",
      outputIndex,
      payload,
    });
  }

  function openReasoningItem(
    controller: TransformStreamDefaultController<Uint8Array>,
    index: number,
  ): void {
    flushMessageItem(controller);
    const itemId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const outputIndex = nextOutputIndex++;
    const item: OpenItem = {
      itemId,
      outputIndex,
      type: "reasoning",
      textParts: [],
      summaryParts: new Map(),
      reasoningParts: new Map(),
    };
    reasoningItems.set(index, item);
    const payload = { summary: [], content: [] };
    send(controller, {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: itemId, type: "reasoning", status: "in_progress", ...payload },
    });
    envelope?.addItem({
      id: itemId,
      type: "reasoning",
      status: "in_progress",
      outputIndex,
      payload,
    });
  }

  function openSummaryPart(
    controller: TransformStreamDefaultController<Uint8Array>,
    item: OpenItem,
    summaryIndex: number,
  ): void {
    if (item.summaryParts.has(summaryIndex)) return;
    item.summaryParts.set(summaryIndex, "");
    send(controller, {
      type: "response.reasoning_summary_part.added",
      item_id: item.itemId,
      output_index: item.outputIndex,
      summary_index: summaryIndex,
      part: { type: "summary_text", text: "" },
    });
  }

  function openReasoningContentPart(
    controller: TransformStreamDefaultController<Uint8Array>,
    item: OpenItem,
    contentIndex: number,
  ): void {
    if (item.reasoningParts.has(contentIndex)) return;
    item.reasoningParts.set(contentIndex, "");
    send(controller, {
      type: "response.content_part.added",
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: contentIndex,
      part: { type: "reasoning_text", text: "" },
    });
  }

  function terminalEvent(
    controller: TransformStreamDefaultController<Uint8Array>,
    finishReason: CanonicalFinishReason | undefined,
  ): void {
    if (terminal || ended) return;
    terminal = true;
    ended = true;
    flushAllItems(controller);
    const env = ensureEnvelope();
    if (cachedUsage) env.setUsage(cachedUsage);
    if (finishReason === "max_tokens" || finishReason === "content_filter") {
      env.setStatus("incomplete", { incompleteDetails: { reason: "max_output_tokens" } });
      send(controller, {
        type: "response.incomplete",
        response: envelopeToWire(env.snapshot()),
      });
    } else {
      env.setStatus("completed");
      send(controller, {
        type: "response.completed",
        response: envelopeToWire(env.snapshot()),
      });
    }
  }

  return new TransformStream<CanonicalStreamEvent, Uint8Array>({
    transform(event, controller) {
      if (terminal) return;

      switch (event.type) {
        case "message_start": {
          if (messageStarted) return;
          messageStarted = true;
          const env = ensureEnvelope();
          if (event.model) {
            env.setModel(event.model);
          }
          sendLifecycle(controller);
          return;
        }

        case "response_state": {
          if (!lifecycleSent) sendLifecycle(controller);
          const env = ensureEnvelope();
          if (event.state === "in_progress") env.setStatus("in_progress");
          send(controller, { type: `response.${event.state}`, response: envelopeToWire(env.snapshot()) });
          return;
        }

        case "text_start": {
          const item = openMessageItem(controller, event.kind ?? "text");
          const contentIndex = item.textParts.length;
          item.textParts.push({
            contentIndex,
            kind: event.kind === "refusal" ? "refusal" : "output_text",
            text: "",
          });
          const part =
            event.kind === "refusal"
              ? { type: "refusal", refusal: "" }
              : { type: "output_text", text: "", annotations: [] };
          send(controller, {
            type: "response.content_part.added",
            item_id: item.itemId,
            output_index: item.outputIndex,
            content_index: contentIndex,
            part,
          });
          return;
        }
        case "text_delta": {
          if (!messageItem) return;
          const part = messageItem.textParts[messageItem.textParts.length - 1];
          if (!part) return;
          part.text += event.text;
          if (event.kind === "refusal") {
            send(controller, {
              type: "response.refusal.delta",
              item_id: messageItem.itemId,
              output_index: messageItem.outputIndex,
              content_index: part.contentIndex,
              delta: event.text,
            });
          } else {
            send(controller, {
              type: "response.output_text.delta",
              item_id: messageItem.itemId,
              output_index: messageItem.outputIndex,
              content_index: part.contentIndex,
              delta: event.text,
            });
          }
          return;
        }
        case "text_end": {
          if (!messageItem) return;
          const part = messageItem.textParts[messageItem.textParts.length - 1];
          if (!part) return;
          if (event.kind === "refusal") {
            send(controller, {
              type: "response.refusal.done",
              item_id: messageItem.itemId,
              output_index: messageItem.outputIndex,
              content_index: part.contentIndex,
              refusal: part.text,
            });
          } else {
            send(controller, {
              type: "response.output_text.done",
              item_id: messageItem.itemId,
              output_index: messageItem.outputIndex,
              content_index: part.contentIndex,
              text: part.text,
            });
          }
          send(controller, {
            type: "response.content_part.done",
            item_id: messageItem.itemId,
            output_index: messageItem.outputIndex,
            content_index: part.contentIndex,
            part:
              event.kind === "refusal"
                ? { type: "refusal", refusal: part.text }
                : { type: "output_text", text: part.text, annotations: [] },
          });
          return;
        }

        case "tool_start": {
          openToolItem(controller, event.index, event.id, event.name, event.kind ?? "function");
          return;
        }
        case "tool_arguments_delta": {
          const item = toolItems.get(event.index);
          if (!item) return;
          item.args = (item.args ?? "") + event.partialJson;
          if (item.toolKind === "custom") {
            send(controller, {
              type: "response.custom_tool_call_input.delta",
              item_id: item.itemId,
              output_index: item.outputIndex,
              delta: event.partialJson,
            });
          } else {
            send(controller, {
              type: "response.function_call_arguments.delta",
              item_id: item.itemId,
              output_index: item.outputIndex,
              delta: event.partialJson,
            });
          }
          return;
        }
        case "tool_end": {
          const item = toolItems.get(event.index);
          if (item) flushToolItem(controller, item);
          return;
        }

        case "reasoning_start": {
          openReasoningItem(controller, event.index);
          return;
        }
        case "reasoning_delta": {
          const item = reasoningItems.get(event.index);
          if (!item) return;
          if (event.kind === "summary") {
            const summaryIndex = event.summaryIndex ?? 0;
            openSummaryPart(controller, item, summaryIndex);
            const prev = item.summaryParts.get(summaryIndex) ?? "";
            item.summaryParts.set(summaryIndex, prev + (event.text ?? ""));
            send(controller, {
              type: "response.reasoning_summary_text.delta",
              item_id: item.itemId,
              output_index: item.outputIndex,
              summary_index: summaryIndex,
              delta: event.text ?? "",
            });
          } else if (event.kind === "text") {
            const contentIndex = 0;
            openReasoningContentPart(controller, item, contentIndex);
            const prev = item.reasoningParts.get(contentIndex) ?? "";
            item.reasoningParts.set(contentIndex, prev + (event.text ?? ""));
            send(controller, {
              type: "response.reasoning_text.delta",
              item_id: item.itemId,
              output_index: item.outputIndex,
              content_index: contentIndex,
              delta: event.text ?? "",
            });
          } else if (event.opaque !== undefined) {
            // Translator-private carrier: never emitted as a public reasoning
            // field (§11.4 native mode).
            report?.({
              code: "reasoning_carrier_updated",
              message:
                "Opaque reasoning carrier updated internally; not emitted as a public Responses field",
              fidelity: "COMPATIBLE",
              field: "content.reasoning",
            });
          }
          return;
        }
        case "reasoning_end": {
          const item = reasoningItems.get(event.index);
          if (!item) return;
          const summaryIndex = event.metadata as { summaryIndex?: number } | undefined;
          const contentIndex = event.metadata as { contentIndex?: number } | undefined;
          if (summaryIndex?.summaryIndex !== undefined) {
            const idx = summaryIndex.summaryIndex;
            if (item.summaryParts.has(idx)) {
              item.summaryParts.delete(idx);
              send(controller, {
                type: "response.reasoning_summary_text.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                summary_index: idx,
                text: "",
              });
              send(controller, {
                type: "response.reasoning_summary_part.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                summary_index: idx,
                part: { type: "summary_text", text: "" },
              });
            }
          } else if (contentIndex?.contentIndex !== undefined) {
            const idx = contentIndex.contentIndex;
            if (item.reasoningParts.has(idx)) {
              item.reasoningParts.delete(idx);
              send(controller, {
                type: "response.reasoning_text.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                content_index: idx,
                text: "",
              });
              send(controller, {
                type: "response.content_part.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                content_index: idx,
                part: { type: "reasoning_text", text: "" },
              });
            }
          } else {
            // Full-item close: flush everything open, then done.
            const summaryIndices = [...item.summaryParts.keys()].sort((a, b) => a - b);
            for (const idx of summaryIndices) {
              item.summaryParts.delete(idx);
              send(controller, {
                type: "response.reasoning_summary_text.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                summary_index: idx,
                text: "",
              });
              send(controller, {
                type: "response.reasoning_summary_part.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                summary_index: idx,
                part: { type: "summary_text", text: "" },
              });
            }
            const contentIndices = [...item.reasoningParts.keys()].sort((a, b) => a - b);
            for (const idx of contentIndices) {
              item.reasoningParts.delete(idx);
              send(controller, {
                type: "response.reasoning_text.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                content_index: idx,
                text: "",
              });
              send(controller, {
                type: "response.content_part.done",
                item_id: item.itemId,
                output_index: item.outputIndex,
                content_index: idx,
                part: { type: "reasoning_text", text: "" },
              });
            }
            flushReasoningItem(controller, item);
          }
          return;
        }

        case "usage":
          cachedUsage = event.usage;
          return;

        case "message_end": {
          if (event.finishReason === undefined || event.finishReason === "unknown") {
            report?.({
              code: "finish_reason_unknown",
              message:
                "Unknown/absent finish reason mapped to status=completed (v0.5 P1-2)",
              fidelity: "COMPATIBLE",
              field: "status",
            });
          }
          terminalEvent(controller, event.finishReason);
          return;
        }

        case "error": {
          if (ended) return;
          terminal = true;
          ended = true;
          flushAllItems(controller);
          const env = ensureEnvelope();
          env.setStatus("failed", { error: { message: event.error.message } });
          send(controller, {
            type: "response.failed",
            response: envelopeToWire(env.snapshot()),
          });
          return;
        }

        case "unknown":
          return;
      }
    },
    flush(controller) {
      if (!terminal && !ended) {
        report?.({
          code: "stream_closed_without_terminal",
          message: "Canonical stream closed without a terminal event; flushed a completed response",
          fidelity: "COMPATIBLE",
          field: "stream",
        });
        terminalEvent(controller, undefined);
      }
    },
  });
}
