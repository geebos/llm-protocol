/**
 * Canonical stream events -> OpenAI Chat SSE (source render).
 *
 * Renders canonical events into OpenAI data-only chunks consumable by the
 * OpenAI JS SDK. Text deltas become `delta.content`; tool calls become
 * `delta.tool_calls` with incremental `arguments`; a declared reasoningField
 * receives reasoning text; each candidate gets its own `choices[].index`
 * (`choice_start`/`choice_end`, docs/07 §7). The stream always ends with
 * `data: [DONE]`.
 */
import type { CanonicalStreamEvent } from "../types.js";
import { encodeDataFrame } from "../sse-parser.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";
import { createStreamBlockKey, streamBlockKeyId } from "../../ir/stream-key.js";
import type { NativeChoiceStreamMetadata } from "../../ir/native/index.js";

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
  const toolPos = new Map<string, number>();
  const toolCounters = new Map<number, number>();
  const choiceMeta = new Map<number, NativeChoiceStreamMetadata>();
  const seenChoices = new Set<number>();
  const finishedChoices = new Set<number>();
  let messageStarted = false;
  let ended = false;
  let terminal = false;
  let reasoningReported = false;
  let cacheUsageReported = false;
  let usageSent = false;
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
    choice: number,
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): void {
    const logprobs = choiceMeta.get(choice)?.logprobs;
    send(controller, {
      choices: [
        {
          index: choice,
          delta,
          finish_reason: finishReason,
          logprobs: logprobs ?? null,
        },
      ],
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

  function flushUsage(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (usageSent || cachedUsage === undefined) return;
    usageSent = true;
    send(controller, { choices: [], usage: renderUsage(cachedUsage) });
  }

  return new TransformStream<CanonicalStreamEvent, Uint8Array>({
    transform(event, controller) {
      // Usage may legally arrive after message_end (compatible providers put it
      // in a final chunk); handle it before the terminal guard.
      if (event.type === "usage") {
        cachedUsage = event.usage;
        if (ended) flushUsage(controller);
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
          seenChoices.add(0);
          chunk(controller, 0, { role: "assistant", content: "" }, null);
          return;
        }

        case "choice_start": {
          if (event.choice === 0) return;
          seenChoices.add(event.choice);
          chunk(controller, event.choice, { role: "assistant", content: "" }, null);
          return;
        }

        case "choice_end": {
          if (finishedChoices.has(event.choice)) return;
          finishedChoices.add(event.choice);
          seenChoices.add(event.choice);
          chunk(
            controller,
            event.choice,
            {},
            FINISH_REASON_MAP[event.finishReason ?? "end_turn"] ?? "stop",
          );
          return;
        }

        case "choice_metadata":
          choiceMeta.set(event.choice, event.native);
          return;

        case "text_start":
          return;
        case "text_delta":
          chunk(controller, event.location.choice ?? 0, { content: event.text }, null);
          return;
        case "text_end":
          return;

        case "reasoning_start":
          return;
        case "reasoning_delta": {
          const choice = event.location.choice ?? 0;
          // Opaque thinking signature (Anthropic signature_delta): only a
          // provider that declares an opaque-signature field can carry it
          // (P1-2); otherwise it is dropped with a warning, never silently.
          if (event.text === undefined) {
            const sigCap = profile.capabilities.reasoning;
            if (event.opaque !== undefined && sigCap?.opaqueSignature && sigCap.signatureField) {
              chunk(controller, choice, { [sigCap.signatureField]: event.opaque }, null);
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
            chunk(controller, choice, { [reasoningField]: event.text }, null);
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
            chunk(controller, choice, { reasoning_content: event.text }, null);
          }
          return;
        }
        case "reasoning_end":
          return;

        case "refusal_start":
          return;
        case "refusal_delta":
          chunk(controller, event.location.choice ?? 0, { refusal: event.text }, null);
          return;
        case "refusal_end":
          return;

        case "tool_start": {
          const choice = event.location.choice ?? 0;
          const pos = toolCounters.get(choice) ?? 0;
          toolCounters.set(choice, pos + 1);
          toolPos.set(streamBlockKeyId(createStreamBlockKey("tool", event.location)), pos);
          chunk(controller, choice, {
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
          const choice = event.location.choice ?? 0;
          const pos = toolPos.get(streamBlockKeyId(createStreamBlockKey("tool", event.location)));
          if (pos === undefined) return;
          chunk(controller, choice, {
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
          if (seenChoices.size === 0 || !finishedChoices.has(0)) {
            finishedChoices.add(0);
            chunk(
              controller,
              0,
              {},
              FINISH_REASON_MAP[event.finishReason ?? "end_turn"] ?? "stop",
            );
          }
          flushUsage(controller);
          return;
        }

        case "error": {
          if (ended) return;
          terminal = true;
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
        if (!finishedChoices.has(0)) {
          chunk(controller, 0, {}, "stop");
        }
        flushUsage(controller);
      }
      controller.enqueue(encodeDataFrame("[DONE]"));
    },
  });
}
