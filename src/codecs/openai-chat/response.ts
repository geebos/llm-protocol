/**
 * OpenAI Chat Completions response codec (FR-005, FR-009, FR-010).
 */
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalResponse } from "../../ir/response.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ContentPart } from "../../ir/types.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { UsageCapabilities } from "../../capabilities/provider-profile.js";
import { validationError } from "../../errors.js";
import type { CodecContext, ResponseCodec } from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";

const FINISH_REASON_MAP: Record<string, CanonicalFinishReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
  refusal: "refusal",
};

const REVERSE_FINISH_REASON_MAP: Partial<Record<CanonicalFinishReason, string>> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_call: "tool_calls",
  content_filter: "content_filter",
  refusal: "refusal",
};

export function createOpenAiChatResponseCodec(
  profile: ProviderProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): ResponseCodec {
  const reasoningField = profile.capabilities.reasoningField;

  return {
    parseResponse(
      payload: unknown,
      ctx: CodecContext = { warnings: [] },
    ): CanonicalResponse {
      if (!payload || typeof payload !== "object") {
        throw validationError("response body must be a JSON object");
      }
      const p = payload as Record<string, unknown>;
      if (p.error && typeof p.error === "object") {
        throw validationError("response contains an error object");
      }
      const choices = Array.isArray(p.choices) ? p.choices : [];
      const choice = (choices[0] as Record<string, unknown> | undefined) ?? {};
      const message = (choice.message as Record<string, unknown> | undefined) ?? {};

      const content = parseContent(message, reasoningField);

      const finishReason =
        typeof choice.finish_reason === "string" && choice.finish_reason !== null
          ? (FINISH_REASON_MAP[choice.finish_reason] ?? "unknown")
          : undefined;

      const extensions: Record<string, unknown> = {};
      if (p.created !== undefined) extensions.created = p.created;
      if (message.refusal !== undefined && message.refusal !== null) {
        extensions.refusal = message.refusal;
      }

      return {
        id: typeof p.id === "string" ? p.id : undefined,
        model: typeof p.model === "string" ? p.model : undefined,
        content,
        finishReason,
        usage: parseUsage(p.usage, profile.capabilities.usage),
        extensions,
      };
    },

    renderResponse(
      canonical: CanonicalResponse,
      ctx: CodecContext = { warnings: [] },
    ): unknown {
      const text = canonical.content
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
      const calls = canonical.content.filter(
        (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
      );
      const reasoning = canonical.content.filter(
        (p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning",
      );

      // Opaque thinking signatures (P1-2): only a provider declaring an
      // opaque-signature field can carry them; otherwise warn, never silently
      // drop the state that may be needed to resume thinking next turn.
      const sigCap = profile.capabilities.reasoning;
      const signature = reasoning
        .map((r) => r.signature)
        .find((s): s is string => typeof s === "string");
      if (signature !== undefined && sigCap?.opaqueSignature && sigCap.signatureField) {
        // preserved under the provider's declared opaque-signature field
      } else if (signature !== undefined) {
        ctx.warnings.push({
          code: "thinking_signature_dropped",
          message:
            "Opaque thinking signature dropped because the target does not declare an opaque-signature field",
          fidelity: "LOSSY",
          field: "content.reasoning.signature",
        });
      }

      const message: Record<string, unknown> = {
        role: "assistant",
        content: text || null,
      };
      if (signature !== undefined && sigCap?.opaqueSignature && sigCap.signatureField) {
        message[sigCap.signatureField] = signature;
      }
      if (reasoningField && reasoning.length) {
        message[reasoningField] = reasoning.map((r) => r.text ?? "").join("");
      } else if (reasoning.length && policies.reasoning === "provider_metadata") {
        // TH-004: preserve reasoning under an explicit provider-metadata field
        // instead of silently dropping it.
        message.reasoning_content = reasoning.map((r) => r.text ?? "").join("");
        ctx.warnings.push({
          code: "reasoning_provider_metadata",
          message:
            "Reasoning preserved as message.reasoning_content per provider_metadata policy",
          fidelity: "COMPATIBLE",
          field: "content.reasoning",
        });
      } else if (reasoning.length) {
        ctx.warnings.push({
          code: "reasoning_dropped",
          message:
            "Reasoning content dropped because the target does not declare a reasoning field (drop_with_warning policy)",
          fidelity: "LOSSY",
          field: "content.reasoning",
        });
      }
      if (calls.length) {
        message.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsText },
        }));
      }
      if (canonical.extensions?.refusal !== undefined) {
        message.refusal = canonical.extensions.refusal;
      }

      return {
        id: canonical.id,
        object: "chat.completion",
        created: canonical.extensions?.created ?? Math.floor(Date.now() / 1000),
        model: canonical.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: renderFinishReason(canonical.finishReason),
            logprobs: null,
          },
        ],
        ...(canonical.usage ? { usage: renderUsage(canonical.usage, ctx) } : {}),
      };
    },
  };
}

function parseContent(
  message: Record<string, unknown>,
  reasoningField: string | undefined,
): ContentPart[] {
  const content: ContentPart[] = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  if (
    reasoningField &&
    typeof message[reasoningField] === "string" &&
    message[reasoningField]
  ) {
    content.push({ type: "reasoning", text: message[reasoningField] as string });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const t = tc as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (t.function && typeof t.function.name === "string") {
        content.push({
          type: "tool_call",
          id: typeof t.id === "string" ? t.id : `call_${content.length}`,
          name: t.function.name,
          argumentsText: typeof t.function.arguments === "string" ? t.function.arguments : "{}",
        });
      }
    }
  }
  return content;
}

function parseUsage(
  usage: unknown,
  caps: UsageCapabilities | undefined,
): CanonicalUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const parsed: CanonicalUsage = {};
  if (typeof u.prompt_tokens === "number") parsed.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number") {
    parsed.outputTokens = u.completion_tokens;
  }
  if (typeof u.total_tokens === "number") parsed.totalTokens = u.total_tokens;
  if (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined) {
    parsed.totalTokens = parsed.inputTokens + parsed.outputTokens;
  }
  const details: Record<string, unknown> = {};
  for (const key of ["prompt_tokens_details", "completion_tokens_details", "prompt_tokens_details_breakdown"]) {
    if (u[key] !== undefined) details[key] = u[key];
  }
  const promptDetails = u.prompt_tokens_details as
    | { cached_tokens?: unknown }
    | undefined;
  if (promptDetails && typeof promptDetails.cached_tokens === "number") {
    parsed.cacheReadTokens = promptDetails.cached_tokens;
  }
  // Compatible providers may report cache write/creation under other names
  // (tech-v2.md §13.2). Only read them when the profile declares the dialect.
  if (caps?.cacheCreation) {
    for (const key of ["cache_creation_tokens", "cache_write_tokens", "cached_creation_tokens"]) {
      if (typeof u[key] === "number") {
        parsed.cacheCreationTokens = u[key] as number;
        break;
      }
    }
  }
  const completionDetails = u.completion_tokens_details as
    | { reasoning_tokens?: unknown }
    | undefined;
  if (completionDetails && typeof completionDetails.reasoning_tokens === "number") {
    parsed.reasoningTokens = completionDetails.reasoning_tokens;
  }
  if (Object.keys(details).length) parsed.providerDetails = details;
  return Object.keys(parsed).length ? parsed : undefined;
}

/**
 * Render canonical usage to OpenAI token counts (P1-1 / 13.4).
 * Anthropic reports cache tokens separately; OpenAI's `prompt_tokens` includes
 * them, so compose when cache fields are present.
 */
function renderUsage(usage: CanonicalUsage, ctx: CodecContext): Record<string, unknown> {
  const cacheTotal =
    (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const promptTokens =
    usage.inputTokens !== undefined && cacheTotal > 0
      ? usage.inputTokens + cacheTotal
      : usage.inputTokens;
  if (usage.inputTokens !== undefined && cacheTotal > 0) {
    ctx.warnings.push({
      code: "cache_usage_approximation",
      message: `Composed prompt_tokens=${promptTokens} from input_tokens + cache tokens for OpenAI`,
      fidelity: "COMPATIBLE",
      field: "usage.prompt_tokens",
    });
  }
  return {
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(usage.outputTokens !== undefined
      ? { completion_tokens: usage.outputTokens }
      : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.providerDetails ?? {}),
  };
}

function renderFinishReason(
  reason: CanonicalFinishReason | undefined,
): string | null {
  if (reason === undefined || reason === "unknown") return null;
  return REVERSE_FINISH_REASON_MAP[reason] ?? "stop";
}
