/**
 * Canonical stream events -> OpenAI Chat SSE (source render).
 *
 * Renders canonical events into OpenAI data-only chunks consumable by the
 * OpenAI JS SDK. Text deltas become `delta.content`; tool calls become
 * `delta.tool_calls` with incremental `arguments`; a declared reasoningField
 * receives reasoning text; the stream always ends with `data: [DONE]`.
 */
import type { CanonicalStreamEvent } from "../types.js";
import { encodeDataFrame } from "../sse-parser.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";

const FINISH_REASON_MAP: Partial<Record<CanonicalFinishReason, string>> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_call: "tool_calls",
  content_filter: "content_filter",
  refusal: "refusal",
};

export function createOpenAiChatStreamRenderer(
  profile: ProviderProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
  report?: (warning: TranslationWarning) => void,
): TransformStream<CanonicalStreamEvent, Uint8Array> {
  const reasoningField = profile.capabilities.reasoningField;
  const toolPos = new Map<number, number>();
  let messageStarted = false;
  let ended = false;
  let terminal = false;
  let errorSent = false;
  let reasoningReported = false;
  let cacheUsageReported = false;
  let cachedUsage: CanonicalUsage | undefined;
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let model: string | undefined;
  let created = Math.floor(Date.now() / 1000);

  function send(
    controller: TransformStreamDefaultController<Uint8Array>,
    data: Record<string, unknown>,
  ): void {
    controller.enqueue(
      encodeDataFrame(
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: model ?? null,
          ...data,
        }),
      ),
    );
  }

  function chunk(
    controller: TransformStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: CanonicalUsage,
  ): void {
    send(controller, {
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      ...(usage ? { usage: renderUsage(usage) } : {}),
    });
  }

  function renderUsage(usage: CanonicalUsage): Record<string, unknown> {
    const cacheTotal =
      (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
    const promptTokens =
      usage.inputTokens !== undefined && cacheTotal > 0
        ? usage.inputTokens + cacheTotal
        : usage.inputTokens;
    if (usage.inputTokens !== undefined && cacheTotal > 0 && !cacheUsageReported) {
      cacheUsageReported = true;
      report?.({
        code: "cache_usage_approximation",
        message: `Composed prompt_tokens=${promptTokens} from input_tokens + cache tokens for OpenAI stream`,
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

  return new TransformStream<CanonicalStreamEvent, Uint8Array>({
    transform(event, controller) {
      // Usage may legally arrive after message_end (compatible providers put it
      // in a final chunk); handle it before the terminal guard.
      if (event.type === "usage") {
        cachedUsage = event.usage;
        if (ended) {
          chunk(controller, {}, null, cachedUsage);
        }
        return;
      }

      if (terminal) return;

      switch (event.type) {
        case "message_start": {
          if (messageStarted) return;
          messageStarted = true;
          if (event.id) id = event.id;
          if (event.model) model = event.model;
          created = Math.floor(Date.now() / 1000);
          chunk(controller, { role: "assistant", content: "" }, null);
          return;
        }

        case "text_start":
          return;
        case "text_delta":
          chunk(controller, { content: event.text }, null);
          return;
        case "text_end":
          return;

        case "reasoning_start":
          return;
        case "reasoning_delta":
          // Opaque thinking signature (Anthropic signature_delta): only a
          // provider that declares an opaque-signature field can carry it
          // (P1-2); otherwise it is dropped with a warning, never silently.
          if (event.text === undefined) {
            const sigCap = profile.capabilities.reasoning;
            if (event.opaque !== undefined && sigCap?.opaqueSignature && sigCap.signatureField) {
              chunk(controller, { [sigCap.signatureField]: event.opaque }, null);
            } else if (event.opaque !== undefined) {
              report?.({
                code: "thinking_signature_dropped",
                message:
                  "Opaque thinking signature dropped because the target does not declare an opaque-signature field",
                fidelity: "LOSSY",
                field: "content.reasoning.signature",
              });
            }
            return;
          }
          if (reasoningField) {
            chunk(controller, { [reasoningField]: event.text }, null);
            return;
          }
          if (!reasoningReported) {
            reasoningReported = true;
            if (policies.reasoning === "provider_metadata") {
              report?.({
                code: "reasoning_provider_metadata",
                message:
                  "Reasoning preserved as delta.reasoning_content per provider_metadata policy",
                fidelity: "COMPATIBLE",
                field: "content.reasoning",
              });
            } else {
              report?.({
                code: "reasoning_dropped",
                message:
                  "Reasoning deltas dropped because the target does not declare a reasoning field (drop_with_warning policy)",
                fidelity: "LOSSY",
                field: "content.reasoning",
              });
            }
          }
          if (policies.reasoning === "provider_metadata") {
            chunk(controller, { reasoning_content: event.text }, null);
          }
          return;
        case "reasoning_end":
          return;

        case "tool_start": {
          const pos = toolPos.size;
          toolPos.set(event.index, pos);
          chunk(controller, {
            tool_calls: [
              {
                index: pos,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: "" },
              },
            ],
          }, null);
          return;
        }
        case "tool_arguments_delta": {
          const pos = toolPos.get(event.index);
          if (pos === undefined) return;
          chunk(controller, {
            tool_calls: [
              {
                index: pos,
                function: { arguments: event.partialJson },
              },
            ],
          }, null);
          return;
        }
        case "tool_end":
          return;

        case "message_end": {
          if (ended) return;
          ended = true;
          terminal = true;
          chunk(
            controller,
            {},
            FINISH_REASON_MAP[event.finishReason ?? "end_turn"] ?? "stop",
            cachedUsage,
          );
          return;
        }

        case "error": {
          if (ended) return;
          terminal = true;
          errorSent = true;
          send(controller, {
            error: { message: event.error.message, type: "server_error" },
          });
          return;
        }

        case "unknown":
          return;
      }
    },
    flush(controller) {
      if (!terminal) {
        ended = true;
        chunk(controller, {}, "stop", cachedUsage);
      }
      controller.enqueue(encodeDataFrame("[DONE]"));
    },
  });
}
