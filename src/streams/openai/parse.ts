/**
 * OpenAI Chat SSE -> canonical stream events (target parse).
 *
 * Stateful TransformStream that handles the OpenAI data-only chunk protocol:
 * - implicit text stream (index 0), explicit `tool_calls` with per-chunk
 *   incremental `arguments`;
 * - a declared `reasoningField` (from the provider profile) maps to a
 *   reasoning block (TH-003: only when declared, never guessed);
 * - `data: [DONE]` terminates without a business event;
 * - `finish_reason` synthesizes the single `message_end`.
 */
import type { CanonicalStreamEvent } from "../types.js";
import type { SSEFrame } from "../sse-parser.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { CanonicalFinishReason } from "../../ir/finish-reason.js";
import type { CanonicalUsage } from "../../ir/usage.js";
import type { TranslationWarning } from "../../ir/fidelity.js";

const FINISH_REASON_MAP: Record<string, CanonicalFinishReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
  refusal: "refusal",
};

interface ToolCallChunk {
  index?: unknown;
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface ChatChunk {
  id?: unknown;
  model?: unknown;
  error?: unknown;
  usage?: unknown;
  choices?: Array<{
    delta?: Record<string, unknown> & { content?: unknown; tool_calls?: ToolCallChunk[] };
    finish_reason?: unknown;
  }>;
}

export function createOpenAiChatStreamParser(
  profile: ProviderProfile,
  report?: (warning: TranslationWarning) => void,
): TransformStream<SSEFrame, CanonicalStreamEvent> {
  const reasoningField = profile.capabilities.reasoningField;
  const toolStates = new Map<number, { started: boolean; ended: boolean }>();
  let messageStarted = false;
  let textStarted = false;
  let textEnded = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let ended = false;

  return new TransformStream<SSEFrame, CanonicalStreamEvent>({
    transform(frame, controller) {
      // OpenAI uses data-only frames; ignore any named event.
      if (frame.event !== "message" && frame.event !== "") return;
      if (frame.data === "[DONE]") return;

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(frame.data) as ChatChunk;
      } catch {
        controller.enqueue({
          type: "error",
          error: { kind: "stream_protocol", message: "invalid JSON in stream chunk" },
        });
        return;
      }

      if (chunk.error) {
        controller.enqueue({
          type: "error",
          error: {
            kind: "stream_protocol",
            message: "upstream stream error",
            providerCode: typeof chunk.error === "string" ? chunk.error : undefined,
          },
        });
        return;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};

      if (!messageStarted && delta.role === "assistant") {
        messageStarted = true;
        controller.enqueue({
          type: "message_start",
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          model: typeof chunk.model === "string" ? chunk.model : undefined,
        });
      }

      if (!messageStarted && (delta.content !== undefined || delta.tool_calls)) {
        // Some providers omit the role on the first chunk; start anyway.
        messageStarted = true;
        controller.enqueue({
          type: "message_start",
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          model: typeof chunk.model === "string" ? chunk.model : undefined,
        });
      }

      if (typeof delta.content === "string" && delta.content !== "") {
        if (!textStarted) {
          textStarted = true;
          controller.enqueue({ type: "text_start", index: 0 });
        }
        controller.enqueue({ type: "text_delta", index: 0, text: delta.content });
      }

      if (reasoningField && typeof delta[reasoningField] === "string" && delta[reasoningField] !== "") {
        if (!reasoningStarted) {
          reasoningStarted = true;
          controller.enqueue({ type: "reasoning_start", index: 0 });
        }
        controller.enqueue({
          type: "reasoning_delta",
          index: 0,
          text: delta[reasoningField] as string,
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const name = tc.function?.name;
          const state = toolStates.get(index);
          if ((!state || !state.started) && (tc.id !== undefined || typeof name === "string")) {
            toolStates.set(index, { started: true, ended: false });
            const id = typeof tc.id === "string" ? tc.id : null;
            if (!id) {
              // TR-002: synthesize a stable, traceable id and report it.
              report?.({
                code: "synthesized_tool_id",
                message: `Synthesized tool_calls id "call_${index}" for tool index ${index}`,
                fidelity: "COMPATIBLE",
                field: `tool_calls[${index}].id`,
              });
            }
            controller.enqueue({
              type: "tool_start",
              index,
              id: id ?? `call_${index}`,
              name: typeof name === "string" ? name : `tool_${index}`,
            });
          }
          if (typeof tc.function?.arguments === "string" && tc.function.arguments !== "") {
            controller.enqueue({
              type: "tool_arguments_delta",
              index,
              partialJson: tc.function.arguments,
            });
          }
        }
      }

      const usage = parseUsage(chunk.usage);
      if (usage) controller.enqueue({ type: "usage", usage });

      if (typeof choice?.finish_reason === "string" && choice.finish_reason !== null) {
        if (!ended) {
          // Close every open block first so start/delta/end stay paired (SR-002).
          // Reasoning opens before text in think-then-answer flows; close in
          // the same order so the renderer keeps interleaving (TH-006).
          if (reasoningStarted && !reasoningEnded) {
            reasoningEnded = true;
            controller.enqueue({ type: "reasoning_end", index: 0 });
          }
          if (textStarted && !textEnded) {
            textEnded = true;
            controller.enqueue({ type: "text_end", index: 0 });
          }
          for (const [index, state] of toolStates) {
            if (state.started && !state.ended) {
              state.ended = true;
              controller.enqueue({ type: "tool_end", index });
            }
          }
          ended = true;
          controller.enqueue({
            type: "message_end",
            finishReason: FINISH_REASON_MAP[choice.finish_reason] ?? "unknown",
          });
        }
      }
    },
  });
}

function parseUsage(usage: unknown): CanonicalUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const parsed: CanonicalUsage = {};
  if (typeof u.prompt_tokens === "number") parsed.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number") parsed.outputTokens = u.completion_tokens;
  if (typeof u.total_tokens === "number") parsed.totalTokens = u.total_tokens;
  if (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined) {
    parsed.totalTokens = parsed.inputTokens + parsed.outputTokens;
  }
  const details: Record<string, unknown> = {};
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    if (u[key] !== undefined) details[key] = u[key];
  }
  if (Object.keys(details).length) parsed.providerDetails = details;
  return Object.keys(parsed).length ? parsed : undefined;
}
