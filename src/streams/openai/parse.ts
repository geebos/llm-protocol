/**
 * OpenAI Chat SSE -> canonical stream events (target parse).
 *
 * Stateful TransformStream hardened for real OpenAI-compatible providers
 * (tech-v2.md M7.1):
 * - explicit active-block state machine: switching between reasoning/text/tool
 *   closes the previous block so start/delta/end stay paired (GAP-001);
 * - ToolCallAccumulator: id/name/arguments may arrive in any fragment order;
 *   `tool_start` is deferred until the name is known and arguments received
 *   before the start are buffered (GAP-002);
 * - finish_reason is NOT the transport terminal: `message_end` is only emitted
 *   on `[DONE]` or EOF, so a late usage-only chunk stays valid (GAP-003/010);
 * - EOF without `[DONE]` finalizes open blocks and reports it (GAP-010).
 *
 * A declared `reasoningField` (from the provider profile) maps to a reasoning
 * block (TH-003: only when declared, never guessed).
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

/** Accumulator for one tool call (tech-v2.md 7.2). */
interface ToolCallState {
  sourceIndex: number;
  id?: string;
  name?: string;
  pendingArguments: string;
  started: boolean;
  ended: boolean;
  /** Deferred because arguments arrived before the tool start (GAP-002). */
  deferredReported: boolean;
}

export function createOpenAiChatStreamParser(
  profile: ProviderProfile,
  report?: (warning: TranslationWarning) => void,
): TransformStream<SSEFrame, CanonicalStreamEvent> {
  const reasoningField = profile.capabilities.reasoningField;

  // Active content-block state (tech-v2.md 6.2).
  let messageStarted = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let textStarted = false;
  let textEnded = false;
  const tools = new Map<number, ToolCallState>();

  // Transport terminal state (tech-v2.md 8.2).
  let finishObserved = false;
  let doneObserved = false;
  let usageAfterFinish = false;
  let finalized = false;
  let errored = false;
  let cachedFinishReason: CanonicalFinishReason | undefined;
  let cachedUsage: CanonicalUsage | undefined;
  let interleavingReported = false;

  function warn(warning: TranslationWarning): void {
    report?.(warning);
  }

  function closeReasoning(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (reasoningStarted && !reasoningEnded) {
      reasoningEnded = true;
      controller.enqueue({ type: "reasoning_end", index: 0 });
    }
  }

  function closeText(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (textStarted && !textEnded) {
      textEnded = true;
      controller.enqueue({ type: "text_end", index: 0 });
    }
  }

  /**
   * End every open tool block; returns true if any was closed. `interleaving`
   * marks tool->text/tool->reasoning switches as non-standard (6.3) and
   * reports them once.
   */
  function closeAllTools(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    interleaving: boolean,
  ): boolean {
    let closed = false;
    for (const [index, state] of tools) {
      if (state.started && !state.ended) {
        state.ended = true;
        controller.enqueue({ type: "tool_end", index });
        closed = true;
      }
    }
    if (closed && interleaving && !interleavingReported) {
      interleavingReported = true;
      warn({
        code: "provider_nonstandard_interleaving",
        message:
          "Provider interleaved tool deltas with another block type; open tool blocks were closed before switching",
        fidelity: "COMPATIBLE",
        field: "choices[0].delta.tool_calls",
      });
    }
    return closed;
  }

  function startReasoning(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (reasoningStarted && !reasoningEnded) return;
    closeText(controller);
    closeAllTools(controller, true);
    reasoningStarted = true;
    reasoningEnded = false;
    controller.enqueue({ type: "reasoning_start", index: 0 });
  }

  function startText(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (textStarted && !textEnded) return;
    closeReasoning(controller);
    closeAllTools(controller, true);
    textStarted = true;
    textEnded = false;
    controller.enqueue({ type: "text_start", index: 0 });
  }

  /** Start a tool block once the name is known (defer otherwise, GAP-002). */
  function startTool(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ToolCallState,
  ): void {
    closeReasoning(controller);
    closeText(controller);
    const id = state.id ?? `call_${state.sourceIndex}`;
    if (state.id === undefined) {
      warn({
        code: "synthesized_tool_id",
        message: `Synthesized tool_calls id "${id}" for tool index ${state.sourceIndex}`,
        fidelity: "COMPATIBLE",
        field: `tool_calls[${state.sourceIndex}].id`,
      });
    }
    state.started = true;
    controller.enqueue({
      type: "tool_start",
      index: state.sourceIndex,
      id,
      name: state.name!,
    });
    if (state.pendingArguments !== "") {
      controller.enqueue({
        type: "tool_arguments_delta",
        index: state.sourceIndex,
        partialJson: state.pendingArguments,
      });
      state.pendingArguments = "";
    }
  }

  function finalize(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (finalized || errored) return;
    finalized = true;

    // Close every open block so start/delta/end stay paired (SR-002).
    closeReasoning(controller);
    closeText(controller);
    for (const [index, state] of tools) {
      if (state.started && !state.ended) {
        state.ended = true;
        controller.enqueue({ type: "tool_end", index });
      }
    }

    // Start + end any tool that never reached tool_start (GAP-002, 7.5).
    for (const state of tools.values()) {
      if (state.started) continue;
      if (state.name === undefined) {
        state.name = `tool_${state.sourceIndex}`;
        warn({
          code: "missing_tool_name",
          message: `Tool call at index ${state.sourceIndex} never delivered a name; synthesized "${state.name}"`,
          fidelity: "LOSSY",
          field: `tool_calls[${state.sourceIndex}].function.name`,
        });
      }
      startTool(controller, state);
      state.ended = true;
      controller.enqueue({ type: "tool_end", index: state.sourceIndex });
    }

    if (usageAfterFinish && !profile.capabilities.usage?.usageAfterFinish) {
      warn({
        code: "late_usage",
        message:
          "Usage arrived after finish_reason; preserved before the terminal event",
        fidelity: "COMPATIBLE",
        field: "usage",
      });
    }
    if (cachedUsage !== undefined) {
      controller.enqueue({ type: "usage", usage: cachedUsage });
    }
    controller.enqueue({ type: "message_end", finishReason: cachedFinishReason });
  }

  return new TransformStream<SSEFrame, CanonicalStreamEvent>({
    transform(frame, controller) {
      // OpenAI uses data-only frames; ignore any named event.
      if (frame.event !== "message" && frame.event !== "") return;
      if (errored || finalized) return;

      if (frame.data === "[DONE]") {
        doneObserved = true;
        finalize(controller);
        return;
      }

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(frame.data) as ChatChunk;
      } catch {
        errored = true;
        controller.enqueue({
          type: "error",
          error: { kind: "stream_protocol", message: "invalid JSON in stream chunk" },
        });
        return;
      }

      if (chunk.error) {
        errored = true;
        const errObj =
          typeof chunk.error === "object" && chunk.error !== null
            ? (chunk.error as { message?: unknown; type?: unknown })
            : undefined;
        controller.enqueue({
          type: "error",
          error: {
            kind: "stream_protocol",
            message:
              typeof errObj?.message === "string"
                ? errObj.message
                : typeof chunk.error === "string"
                  ? chunk.error
                  : "upstream stream error",
            providerCode:
              typeof errObj?.type === "string"
                ? errObj.type
                : typeof chunk.error === "string"
                  ? chunk.error
                  : undefined,
          },
        });
        return;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};

      const hasBusinessPayload =
        delta.role === "assistant" ||
        delta.content !== undefined ||
        Array.isArray(delta.tool_calls) ||
        (reasoningField !== undefined &&
          typeof delta[reasoningField] === "string" &&
          delta[reasoningField] !== "");
      if (!messageStarted && hasBusinessPayload) {
        messageStarted = true;
        controller.enqueue({
          type: "message_start",
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          model: typeof chunk.model === "string" ? chunk.model : undefined,
        });
      }

      if (
        reasoningField &&
        typeof delta[reasoningField] === "string" &&
        delta[reasoningField] !== ""
      ) {
        startReasoning(controller);
        controller.enqueue({
          type: "reasoning_delta",
          index: 0,
          text: delta[reasoningField] as string,
        });
      }

      if (typeof delta.content === "string" && delta.content !== "") {
        startText(controller);
        controller.enqueue({ type: "text_delta", index: 0, text: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const state = tools.get(index) ?? {
            sourceIndex: index,
            pendingArguments: "",
            started: false,
            ended: false,
            deferredReported: false,
          };
          if (typeof tc.id === "string") state.id = tc.id;
          if (tc.function && typeof tc.function.name === "string") {
            state.name = tc.function.name;
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args !== "") {
            if (state.started) {
              controller.enqueue({
                type: "tool_arguments_delta",
                index,
                partialJson: args,
              });
            } else {
              if (!state.deferredReported) {
                state.deferredReported = true;
                // A provider declared to split tool metadata needs no warning;
                // it is the declared dialect (GAP-014).
                if (!profile.capabilities.stream?.maySplitToolMetadata) {
                  warn({
                    code: "tool_metadata_deferred",
                    message: `Tool call index ${index} delivered arguments before its name; buffered until tool_start`,
                    fidelity: "COMPATIBLE",
                    field: `tool_calls[${index}].function.arguments`,
                  });
                }
              }
              state.pendingArguments += args;
            }
          }
          if (!state.started && state.name !== undefined) {
            startTool(controller, state);
          }
          tools.set(index, state);
        }
      }

      const usage = parseUsage(chunk.usage, profile.capabilities.usage);
      if (usage) {
        if (finishObserved) usageAfterFinish = true;
        cachedUsage = usage;
      }

      if (
        typeof choice?.finish_reason === "string" &&
        choice.finish_reason !== null
      ) {
        finishObserved = true;
        cachedFinishReason = FINISH_REASON_MAP[choice.finish_reason] ?? "unknown";
      }
    },
    flush(controller) {
      if (errored || finalized) return;
      // Providers that declare they never send [DONE] (dialect, GAP-014) do
      // not trigger the abnormal-close warning.
      const doneMarker = profile.capabilities.stream?.doneMarker;
      if (!doneObserved && doneMarker !== false) {
        warn({
          code: "stream_closed_without_done",
          message:
            "Upstream closed the stream without sending data: [DONE]; finalized on EOF",
          fidelity: "COMPATIBLE",
          field: "stream",
        });
      }
      if (!finishObserved) {
        warn({
          code: "stream_closed_without_finish",
          message:
            "Upstream closed the stream without a finish_reason; synthesized terminal event",
          fidelity: "COMPATIBLE",
          field: "choices[0].finish_reason",
        });
      }
      finalize(controller);
    },
  });
}

function parseUsage(
  usage: unknown,
  caps: ProviderProfile["capabilities"]["usage"] | undefined,
): CanonicalUsage | undefined {
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
