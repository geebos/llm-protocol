/**
 * OpenAI Chat Completions response codec (FR-005, FR-009, FR-010).
 */
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalChoice, CanonicalResponse } from "../../ir/response.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ContentPart } from "../../ir/types.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { UsageCapabilities } from "../../capabilities/provider-profile.js";
import { validationError } from "../../errors.js";
import type { CodecContext, ResponseCodec } from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";
import { fieldProjectionError } from "../../ir/projection/role.js";

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
      const rawChoices = Array.isArray(p.choices) ? p.choices : [];
      const choices: CanonicalChoice[] = rawChoices.map((raw, i) => {
        const choice = (raw as Record<string, unknown> | undefined) ?? {};
        const message = (choice.message as Record<string, unknown> | undefined) ?? {};
        const finishReason =
          typeof choice.finish_reason === "string" && choice.finish_reason !== null
            ? (FINISH_REASON_MAP[choice.finish_reason] ?? "unknown")
            : undefined;
        const native: CanonicalChoice["native"] = {};
        if (choice.logprobs !== undefined && choice.logprobs !== null) {
          native.chat = { logprobs: choice.logprobs as Record<string, unknown> };
        }
        return {
          index: typeof choice.index === "number" ? choice.index : i,
          content: parseContent(message, reasoningField),
          finishReason,
          ...(Object.keys(native).length ? { native } : {}),
        };
      });

      const extensions: Record<string, unknown> = {};
      if (p.created !== undefined) extensions.created = p.created;

      return {
        id: typeof p.id === "string" ? p.id : undefined,
        model: typeof p.model === "string" ? p.model : undefined,
        choices,
        usage: parseUsage(p.usage, profile.capabilities.usage),
        extensions,
      };
    },

    renderResponse(
      canonical: CanonicalResponse,
      ctx: CodecContext = { warnings: [] },
    ): unknown {
      const sigCap = profile.capabilities.reasoning;
      const sourceChoices: CanonicalChoice[] = canonical.choices.length
        ? canonical.choices
        : [{ index: 0, content: [] }];

      const choices = sourceChoices.map((choice, i) => {
        const content = choice.content;
        if (content.some((p) => p.type === "opaque_native")) {
          throw fieldProjectionError("opaque_native", "openai-chat");
        }
        const text = content
          .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
        const calls = content.filter(
          (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
        );
        const reasoning = content.filter(
          (p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning",
        );
        const refusal = content.find(
          (p): p is Extract<ContentPart, { type: "refusal" }> => p.type === "refusal",
        );

        const message: Record<string, unknown> = {
          role: "assistant",
          content: text || null,
        };
        // Opaque thinking signatures (P1-2): only a provider declaring an
        // opaque-signature field can carry them; otherwise warn, never silently
        // drop the state that may be needed to resume thinking next turn.
        const signature = reasoning
          .map((r) => r.signature)
          .find((s): s is string => typeof s === "string");
        if (signature !== undefined && sigCap?.opaqueSignature && sigCap.signatureField) {
          message[sigCap.signatureField] = signature;
        } else if (signature !== undefined && i === 0) {
          ctx.warnings.push({
            code: "thinking_signature_dropped",
            message:
              "Opaque thinking signature dropped because the target does not declare an opaque-signature field",
            fidelity: "LOSSY",
            field: "content.reasoning.signature",
          });
        }
        if (reasoningField && reasoning.length) {
          message[reasoningField] = reasoning.map((r) => r.text ?? "").join("");
        } else if (reasoning.length && policies.reasoning === "provider_metadata") {
          message.reasoning_content = reasoning.map((r) => r.text ?? "").join("");
          if (i === 0) {
            ctx.warnings.push({
              code: "reasoning_provider_metadata",
              message:
                "Reasoning preserved as message.reasoning_content per provider_metadata policy",
              fidelity: "COMPATIBLE",
              field: "content.reasoning",
            });
          }
        } else if (reasoning.length && i === 0) {
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
        if (refusal) message.refusal = refusal.text;

        return {
          index: choice.index ?? i,
          message,
          finish_reason: renderFinishReason(choice.finishReason),
          logprobs: choice.native?.chat?.logprobs ?? null,
        };
      });

      return {
        id: canonical.id,
        object: "chat.completion",
        created: canonical.extensions?.created ?? Math.floor(Date.now() / 1000),
        model: canonical.model,
        choices,
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
  if (typeof message.refusal === "string" && message.refusal) {
    content.push({ type: "refusal", text: message.refusal });
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
  // Canonical inputTokens is pure input, EXCLUDING cache tokens. OpenAI's
  // prompt_tokens includes cached tokens, so split them out when the details
  // are reported (keeps the IR additive across protocols and round-trips).
  const promptTokens = u.prompt_tokens;
  if (typeof promptTokens === "number") {
    const promptDetails = u.prompt_tokens_details as
      | { cached_tokens?: unknown }
      | undefined;
    const cached =
      promptDetails && typeof promptDetails.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : 0;
    parsed.inputTokens = Math.max(0, promptTokens - cached);
    if (cached > 0) parsed.cacheReadTokens = cached;
  }
  if (typeof u.completion_tokens === "number") {
    parsed.outputTokens = u.completion_tokens;
  }
  const details: Record<string, unknown> = {};
  for (const key of ["prompt_tokens_details", "completion_tokens_details", "prompt_tokens_details_breakdown"]) {
    if (u[key] !== undefined) details[key] = u[key];
  }
  // Compatible providers may report cache write/creation under other names
  // (02.tech-v2.md §13.2). Only read them when the profile declares the dialect.
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
  // totalTokens is the additive whole: pure input + cache + output.
  if (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined) {
    parsed.totalTokens =
      parsed.inputTokens +
      (parsed.cacheReadTokens ?? 0) +
      (parsed.cacheCreationTokens ?? 0) +
      parsed.outputTokens;
  } else if (typeof u.total_tokens === "number") {
    parsed.totalTokens = u.total_tokens;
  }
  if (Object.keys(details).length) parsed.providerDetails = details;
  return Object.keys(parsed).length ? parsed : undefined;
}

/**
 * Render canonical usage to OpenAI token counts (P1-1 / 13.4).
 * Canonical inputTokens excludes cache; OpenAI's `prompt_tokens` includes it,
 * so compose when cache fields are present.
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
