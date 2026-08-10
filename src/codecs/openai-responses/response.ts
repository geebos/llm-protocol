/**
 * OpenAI Responses response codec (responses.md §8/§9).
 *
 * parseResponse: Responses response object -> CanonicalResponse. Status and
 * finishReason stay on independent axes (v0.5 P1-2): only explicit truncation
 * yields `incomplete`; unknown finish reasons with a successful return stay
 * `completed` (+ warning).
 *
 * renderResponse: CanonicalResponse -> Responses response object, using the
 * same terminal-status derivation table as the stream state machine (§8.2/
 * §13.5) so stream aggregation and non-streaming stay consistent. Missing
 * response/item ids come from the Synthetic ID Factory (§8.3) and are
 * trace-marked, never impersonating upstream IDs.
 */
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalResponse, CanonicalResponseStatus } from "../../ir/response.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ContentPart } from "../../ir/types.js";
import { validationError } from "../../errors.js";
import type { CodecContext, ResponseCodec, ToolCallEntry } from "../protocol-adapter.js";
import { ensureToolCallRegistry } from "../protocol-adapter.js";
import { registerToolCall } from "./normalize.js";
import { createSyntheticIdFactory } from "./ids.js";
import { usageToWire } from "./envelope.js";
import { parseUsage } from "./usage.js";

/** §8.2: CanonicalFinishReason -> Responses status (independent axes). */
export function finishReasonToStatus(
  reason: CanonicalFinishReason | undefined,
): { status: CanonicalResponseStatus; reason: CanonicalFinishReason | undefined } {
  switch (reason) {
    case "max_tokens":
    case "content_filter":
      return { status: "incomplete", reason };
    default:
      // end_turn / tool_call / stop_sequence / refusal / pause_turn /
      // unknown all complete normally (v0.5 P1-2).
      return { status: "completed", reason };
  }
}

const STATUS_TO_FINISH: Partial<Record<string, CanonicalFinishReason>> = {
  completed: "end_turn",
  incomplete: "max_tokens",
};

export const openaiResponsesResponseCodec: ResponseCodec = {
  parseResponse(
    payload: unknown,
    ctx: CodecContext = { warnings: [] },
  ): CanonicalResponse {
    if (!payload || typeof payload !== "object") {
      throw validationError("response body must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    const rawStatus = typeof p.status === "string" ? p.status : undefined;
    const hasTerminalStatus =
      rawStatus === "completed" ||
      rawStatus === "incomplete" ||
      rawStatus === "failed" ||
      rawStatus === "cancelled";
    // `{ object: "error" }` is an API error envelope, not a Response body.
    // A Response terminal state `{ object: "response", status: "failed",
    // error: {...} }` is a legal CanonicalResponseStatus axis and must parse
    // normally with its error metadata preserved (review round 2).
    if (p.object === "error" || (p.error && typeof p.error === "object" && !hasTerminalStatus)) {
      throw validationError("response contains an error object");
    }

    ctx.syntheticIds ??= createSyntheticIdFactory();

    const output = Array.isArray(p.output) ? p.output : [];
    const content = parseOutputItems(output, ctx);

    let status: CanonicalResponseStatus | undefined;
    let finishReason: CanonicalFinishReason | undefined;
    switch (rawStatus) {
      case "completed":
        status = "completed";
        // A completed response with tool calls stopped to run tools.
        finishReason = content.some(
          (c) => c.type === "tool_call" || c.type === "tool_result",
        )
          ? "tool_call"
          : "end_turn";
        break;
      case "incomplete":
        status = "incomplete";
        finishReason = "max_tokens";
        break;
      case "failed":
      case "cancelled":
        status = rawStatus;
        finishReason = "unknown";
        break;
      default:
        // queued/in_progress are lifecycle states, not terminal; absent status
        // on a parsed body means the caller got a non-terminal object.
        if (rawStatus === undefined) {
          ctx.warnings.push({
            code: "missing_response_status",
            message: "Responses response has no status; treated as completed",
            fidelity: "COMPATIBLE",
            field: "status",
          });
          status = "completed";
        }
    }

    const extensions: Record<string, unknown> = {};
    if (p.created_at !== undefined) extensions.createdAt = p.created_at;
    if (p.incomplete_details !== undefined) {
      extensions.incompleteDetails = p.incomplete_details;
    }
    if (p.error !== undefined) extensions.error = p.error;
    if (rawStatus !== undefined) extensions.status = rawStatus;

    return {
      id: typeof p.id === "string" ? p.id : undefined,
      model: typeof p.model === "string" ? p.model : undefined,
      content,
      finishReason,
      status,
      usage: parseUsage(p.usage),
      extensions,
    };
  },

  renderResponse(
    canonical: CanonicalResponse,
    ctx: CodecContext = { warnings: [] },
  ): unknown {
    ctx.syntheticIds ??= createSyntheticIdFactory();

    const { status } = finishReasonToStatus(canonical.finishReason);
    if (canonical.finishReason === undefined || canonical.finishReason === "unknown") {
      ctx.warnings.push({
        code: "finish_reason_unknown",
        message:
          "Unknown/absent finish reason with a successful response mapped to status=completed (v0.5 P1-2)",
        fidelity: "COMPATIBLE",
        field: "status",
      });
    }

    const id = canonical.id ?? ctx.syntheticIds.responseId();
    if (canonical.id === undefined) {
      ctx.warnings.push({
        code: "synthetic_response_id",
        message: `Synthesized Responses response id "${id}" (origin=synthetic, trace-only)`,
        fidelity: "COMPATIBLE",
        field: "id",
      });
    }

    const createdAt =
      typeof (canonical.extensions as Record<string, unknown> | undefined)?.createdAt === "number"
        ? ((canonical.extensions as Record<string, unknown>).createdAt as number)
        : Math.floor(Date.now() / 1000);

    const output = renderOutputItems(canonical.content, ctx);

    const body: Record<string, unknown> = {
      id,
      object: "response",
      created_at: createdAt,
      status,
      error: canonical.extensions?.error ?? null,
      incomplete_details:
        status === "incomplete"
          ? (canonical.extensions?.incompleteDetails ?? { reason: "max_output_tokens" })
          : null,
      instructions: null,
      max_output_tokens: null,
      model: canonical.model ?? null,
      output,
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: null,
      store: false,
      temperature: null,
      text: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      truncation: "disabled",
      usage: canonical.usage ? renderUsage(canonical.usage, ctx) : null,
      user: null,
      metadata: {},
    };
    // Round-trip the lifecycle/status extension if the source carried it.
    if (canonical.extensions?.status !== undefined) {
      body.status = canonical.extensions.status;
    }
    return body;
  },
};

function parseOutputItems(
  output: unknown[],
  ctx: CodecContext,
): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    switch (it.type) {
      case "message": {
        const content = Array.isArray(it.content) ? it.content : [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "output_text" && typeof b.text === "string") {
            if (b.text !== "") {
              parts.push({
                type: "text",
                text: b.text,
                // output_text.annotations is part metadata (v0.3 P2-1);
                // preserved verbatim, never rewritten (review round 2).
                ...(Array.isArray(b.annotations)
                  ? { annotations: b.annotations }
                  : {}),
              });
            }
          } else if (b.type === "refusal" && typeof b.refusal === "string") {
            parts.push({ type: "refusal", text: b.refusal });
          } else {
            ctx.warnings.push({
              code: "unknown_message_part",
              message: `Unknown Responses message output part "${String(b.type)}" skipped`,
              fidelity: "LOSSY",
              field: "output.message.content",
            });
          }
        }
        break;
      }
      case "reasoning": {
        const summaryParts = parseSubParts(it.summary, true);
        const textParts = parseSubParts(it.content, false);
        const part: ContentPart = {
          type: "reasoning",
          ...(summaryParts.length === 1 ? { summary: summaryParts[0].text } : {}),
          ...(summaryParts.length > 1 ? { summaryParts } : {}),
          ...(textParts.length === 1 ? { text: textParts[0].text } : {}),
          ...(textParts.length > 1 ? { textParts } : {}),
          ...(typeof it.encrypted_content === "string"
            ? { encryptedContent: it.encrypted_content }
            : {}),
        };
        if (it.id !== undefined) {
          part.reasoningId = typeof it.id === "string" ? it.id : undefined;
        }
        parts.push(part);
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const isCustom = it.type === "custom_tool_call";
        const name = typeof it.name === "string" ? it.name : `tool_${parts.length}`;
        const callId =
          typeof it.call_id === "string" ? it.call_id : `call_${parts.length}`;
        registerToolCall(ctx, callId, {
          normalizedToolName: name,
          originalName: name,
          executionKind: isCustom ? "custom" : "function",
        });
        if (isCustom) {
          parts.push({
            type: "tool_call",
            kind: "custom",
            id: callId,
            name,
            inputText: typeof it.input === "string" ? it.input : String(it.input ?? ""),
          });
        } else {
          parts.push({
            type: "tool_call",
            kind: "function",
            id: callId,
            name,
            argumentsText: typeof it.arguments === "string" ? it.arguments : "{}",
          });
        }
        break;
      }
      default:
        ctx.warnings.push({
          code: "unknown_output_item",
          message: `Unknown Responses output item type "${String(it.type)}" skipped`,
          fidelity: "LOSSY",
          field: "output",
        });
    }
  }
  return parts;
}

function parseSubParts(
  raw: unknown,
  summary: boolean,
): Array<{ text: string; summaryIndex?: number; contentIndex?: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is Record<string, unknown> =>
        !!s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string",
    )
    .map((s, i) => (summary ? { text: s.text as string, summaryIndex: i } : { text: s.text as string, contentIndex: i }));
}

function renderOutputItems(content: ContentPart[], ctx: CodecContext): unknown[] {
  const items: unknown[] = [];
  // Aggregate adjacent text/refusal parts into a single message item; tool
  // calls and reasoning become independent items (output_index ordering).
  let messageItem: { parts: Array<{ type: string; text?: string; refusal?: string; annotations?: unknown[] }> } | undefined;

  const flushMessage = (): void => {
    if (messageItem) {
      const item: Record<string, unknown> = {
        id: ctx.syntheticIds?.itemId("message"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: messageItem.parts,
      };
      items.push(item);
      messageItem = undefined;
    }
  };

  for (const part of content) {
    if (part.type === "text" || part.type === "refusal") {
      messageItem ??= { parts: [] };
      if (part.type === "text") {
        messageItem.parts.push({
          type: "output_text",
          text: part.text,
          ...(part.annotations?.length ? { annotations: part.annotations } : {}),
        });
      } else {
        messageItem.parts.push({ type: "refusal", refusal: part.text });
      }
      continue;
    }
    flushMessage();

    if (part.type === "tool_call") {
      const entry = lookupCall(ctx, part.id);
      const isCustom = part.kind === "custom" || entry?.executionKind === "custom";
      if (isCustom) {
        items.push({
          id: ctx.syntheticIds?.itemId("custom"),
          type: "custom_tool_call",
          status: "completed",
          name: part.name,
          call_id: part.id,
          input: part.kind === "custom" ? part.inputText : "",
        });
      } else {
        items.push({
          id: ctx.syntheticIds?.itemId("function"),
          type: "function_call",
          status: "completed",
          name: part.name,
          call_id: part.id,
          arguments: part.argumentsText,
        });
      }
      continue;
    }
    if (part.type === "reasoning") {
      items.push({
        id: ctx.syntheticIds?.itemId("reasoning"),
        type: "reasoning",
        status: "completed",
        ...(part.reasoningId ? { id: part.reasoningId } : {}),
        summary: (part.summaryParts ?? (part.summary !== undefined ? [{ text: part.summary }] : [])).map(
          (s) => ({ type: "summary_text", text: s.text }),
        ),
        content: (part.textParts ?? (part.text !== undefined ? [{ text: part.text }] : [])).map(
          (t) => ({ type: "reasoning_text", text: t.text }),
        ),
      });
      continue;
    }
    // tool_result / image / file in a response body are not rendered back as
    // output items (they belong to request turns).
    ctx.warnings.push({
      code: "response_part_skipped",
      message: `Content part "${part.type}" skipped in Responses response output`,
      fidelity: "LOSSY",
      field: "output",
    });
  }
  flushMessage();
  return items;
}

function lookupCall(ctx: CodecContext, callId: string): ToolCallEntry | undefined {
  return ensureToolCallRegistry(ctx).byCallId.get(callId);
}

/**
 * §14.1: IR -> Responses usage. Anthropic-style input (uncached + cacheWrite +
 * cacheRead) expands into `input_tokens`; cached subset reported in details.
 * Shared wire shape with the stream envelope (envelope.usageToWire).
 */
function renderUsage(usage: CanonicalUsage, ctx: CodecContext): Record<string, unknown> {
  const cacheTotal =
    (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  if (usage.inputTokens !== undefined && cacheTotal > 0) {
    ctx.warnings.push({
      code: "cache_usage_composed",
      message: `Composed Responses input_tokens=${usage.inputTokens + cacheTotal} from input_tokens + cache tokens`,
      fidelity: "COMPATIBLE",
      field: "usage.input_tokens",
    });
  }
  return usageToWire(usage);
}
