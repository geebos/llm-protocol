/**
 * Anthropic Messages response codec (FR-005, FR-009, FR-010).
 */
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalResponse } from "../../ir/response.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ContentPart } from "../../ir/types.js";
import { validationError } from "../../errors.js";
import type { CodecContext, ResponseCodec } from "../protocol-adapter.js";
import { parseAnthropicContent, renderAnthropicContent } from "./content.js";

const STOP_REASON_MAP: Record<string, CanonicalFinishReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  tool_use: "tool_call",
  refusal: "refusal",
};

const REVERSE_STOP_REASON_MAP: Partial<Record<CanonicalFinishReason, string>> = {
  end_turn: "end_turn",
  tool_call: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  refusal: "refusal",
};

export const anthropicResponseCodec: ResponseCodec = {
  parseResponse(
    payload: unknown,
    ctx: CodecContext = { warnings: [] },
  ): CanonicalResponse {
    if (!payload || typeof payload !== "object") {
      throw validationError("response body must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    if (p.type === "error") {
      throw validationError("response contains an error object");
    }

    const content = Array.isArray(p.content)
      ? parseAnthropicContent(p.content, ctx)
      : [];

    const stopReason =
      typeof p.stop_reason === "string"
        ? (STOP_REASON_MAP[p.stop_reason] ?? "unknown")
        : undefined;

    const usage = parseUsage(p.usage);

    const extensions: Record<string, unknown> = {};
    if (p.stop_sequence !== undefined) extensions.stopSequence = p.stop_sequence;
    if (p.role !== undefined) extensions.role = p.role;

    return {
      id: typeof p.id === "string" ? p.id : undefined,
      model: typeof p.model === "string" ? p.model : undefined,
      content,
      finishReason: stopReason,
      usage,
      extensions,
    };
  },

  renderResponse(
    canonical: CanonicalResponse,
    ctx: CodecContext = { warnings: [] },
  ): unknown {
    const body: Record<string, unknown> = {
      id: canonical.id,
      type: "message",
      role: "assistant",
      model: canonical.model,
      content: renderAnthropicContent(canonical.content),
      stop_reason: renderStopReason(canonical.finishReason, ctx),
      stop_sequence: canonical.extensions?.stopSequence ?? null,
    };
    if (canonical.usage) body.usage = renderUsage(canonical.usage);
    return body;
  },
};

function parseUsage(usage: unknown): CanonicalUsage | undefined {
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
  if (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined) {
    parsed.totalTokens = parsed.inputTokens + parsed.outputTokens;
  }
  return parsed;
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
  };
}

function renderStopReason(
  reason: CanonicalFinishReason | undefined,
  ctx: CodecContext,
): string | null {
  if (reason === undefined) return null;
  const mapped = REVERSE_STOP_REASON_MAP[reason];
  if (mapped) return mapped;
  if (reason === "content_filter") {
    ctx.warnings.push({
      code: "stop_reason_lossy",
      message: "content_filter stop reason mapped to end_turn for Anthropic",
      fidelity: "LOSSY",
      field: "finishReason",
    });
    return "end_turn";
  }
  if (reason === "unknown") {
    ctx.warnings.push({
      code: "stop_reason_unknown",
      message: "Unknown stop reason mapped to end_turn for Anthropic",
      fidelity: "LOSSY",
      field: "finishReason",
    });
    return "end_turn";
  }
  return null;
}
