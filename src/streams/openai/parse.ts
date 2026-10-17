/**
 * OpenAI Chat SSE -> canonical stream events (target parse).
 *
 * Stateful TransformStream hardened for real OpenAI-compatible providers
 * (02.tech-v2.md M7.1):
 * - explicit per-choice active-block state machine: switching between
 *   reasoning/text/tool closes the previous block so start/delta/end stay
 *   paired (GAP-001);
 * - ToolCallAccumulator: id/name/arguments may arrive in any fragment order;
 *   `tool_start` is deferred until the name is known and arguments received
 *   before the start are buffered (GAP-002);
 * - finish_reason is NOT the transport terminal: `message_end` is only emitted
 *   on `[DONE]` or EOF, so a late usage-only chunk stays valid (GAP-003/010);
 * - EOF without `[DONE]` finalizes open blocks and reports it (GAP-010);
 * - multi-candidate responses (`n > 1`) keep an independent state machine per
 *   `choices[].index` and emit `choice_start`/`choice_end` (docs/07 §7, L-2).
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

interface ChatChoiceChunk {
  index?: unknown;
  delta?: Record<string, unknown> & {
    content?: unknown;
    refusal?: unknown;
    tool_calls?: ToolCallChunk[];
  };
  finish_reason?: unknown;
}

interface ChatChunk {
  id?: unknown;
  model?: unknown;
  error?: unknown;
  usage?: unknown;
  choices?: ChatChoiceChunk[];
}

/** Accumulator for one tool call (02.tech-v2.md 7.2). */
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

/** Independent block state machine for one candidate. */
interface ChoiceState {
  index: number;
  started: boolean;
  ended: boolean;
  reasoningStarted: boolean;
  reasoningEnded: boolean;
  textStarted: boolean;
  textEnded: boolean;
  refusalStarted: boolean;
  refusalEnded: boolean;
  tools: Map<number, ToolCallState>;
  finishReason?: CanonicalFinishReason;
}

export function createOpenAiChatStreamParser(
  profile: ProviderProfile,
  report?: (warning: TranslationWarning) => void,
): TransformStream<SSEFrame, CanonicalStreamEvent> {
  const reasoningField = profile.capabilities.reasoningField;

  const choices = new Map<number, ChoiceState>();

  // Transport-level state (02.tech-v2.md 8.2).
  let messageStarted = false;
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

  function choiceState(index: number): ChoiceState {
    let state = choices.get(index);
    if (!state) {
      state = {
        index,
        started: false,
        ended: false,
        reasoningStarted: false,
        reasoningEnded: false,
        textStarted: false,
        textEnded: false,
        refusalStarted: false,
        refusalEnded: false,
        tools: new Map(),
      };
      choices.set(index, state);
    }
    return state;
  }

  function ensureStarted(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.started) return;
    state.started = true;
    controller.enqueue({ type: "choice_start", choice: state.index });
  }

  function closeReasoning(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.reasoningStarted && !state.reasoningEnded) {
      state.reasoningEnded = true;
      controller.enqueue({
        type: "reasoning_end",
        location: { choice: state.index, content: 0 },
      });
    }
  }

  function closeText(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.textStarted && !state.textEnded) {
      state.textEnded = true;
      controller.enqueue({ type: "text_end", location: { choice: state.index, content: 0 } });
    }
  }

  function closeRefusal(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.refusalStarted && !state.refusalEnded) {
      state.refusalEnded = true;
      controller.enqueue({ type: "refusal_end", location: { choice: state.index, content: 0 } });
    }
  }

  /**
   * End every open tool block; returns true if any was closed. `interleaving`
   * marks tool->text/tool->reasoning switches as non-standard (6.3) and
   * reports them once.
   */
  function closeAllTools(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
    interleaving: boolean,
  ): boolean {
    let closed = false;
    for (const [index, tool] of state.tools) {
      if (tool.started && !tool.ended) {
        tool.ended = true;
        controller.enqueue({
          type: "tool_end",
          location: { choice: state.index, content: index },
        });
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

  function closeAllBlocks(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    closeReasoning(controller, state);
    closeText(controller, state);
    closeRefusal(controller, state);
    closeAllTools(controller, state, true);
  }

  function startReasoning(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.reasoningStarted && !state.reasoningEnded) return;
    closeText(controller, state);
    closeRefusal(controller, state);
    closeAllTools(controller, state, true);
    state.reasoningStarted = true;
    state.reasoningEnded = false;
    controller.enqueue({
      type: "reasoning_start",
      location: { choice: state.index, content: 0 },
    });
  }

  function startText(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.textStarted && !state.textEnded) return;
    closeReasoning(controller, state);
    closeRefusal(controller, state);
    closeAllTools(controller, state, true);
    state.textStarted = true;
    state.textEnded = false;
    controller.enqueue({ type: "text_start", location: { choice: state.index, content: 0 } });
  }

  function startRefusal(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    if (state.refusalStarted && !state.refusalEnded) return;
    closeReasoning(controller, state);
    closeText(controller, state);
    closeAllTools(controller, state, true);
    state.refusalStarted = true;
    state.refusalEnded = false;
    controller.enqueue({
      type: "refusal_start",
      location: { choice: state.index, content: 0 },
    });
  }

  /** Start a tool block once the name is known (defer otherwise, GAP-002). */
  function startTool(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
    tool: ToolCallState,
  ): void {
    closeReasoning(controller, state);
    closeText(controller, state);
    closeRefusal(controller, state);
    const id = tool.id ?? `call_${tool.sourceIndex}`;
    if (tool.id === undefined) {
      warn({
        code: "synthesized_tool_id",
        message: `Synthesized tool_calls id "${id}" for tool index ${tool.sourceIndex}`,
        fidelity: "COMPATIBLE",
        field: `tool_calls[${tool.sourceIndex}].id`,
      });
    }
    tool.started = true;
    controller.enqueue({
      type: "tool_start",
      location: { choice: state.index, content: tool.sourceIndex },
      id,
      name: tool.name!,
    });
    if (tool.pendingArguments !== "") {
      controller.enqueue({
        type: "tool_arguments_delta",
        location: { choice: state.index, content: tool.sourceIndex },
        partialJson: tool.pendingArguments,
      });
      tool.pendingArguments = "";
    }
  }

  /** Start + end any tool that never reached tool_start (GAP-002, 7.5). */
  function flushPendingTools(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    state: ChoiceState,
  ): void {
    for (const tool of state.tools.values()) {
      if (tool.started) continue;
      if (tool.name === undefined) {
        tool.name = `tool_${tool.sourceIndex}`;
        warn({
          code: "missing_tool_name",
          message: `Tool call at index ${tool.sourceIndex} never delivered a name; synthesized "${tool.name}"`,
          fidelity: "LOSSY",
          field: `tool_calls[${tool.sourceIndex}].function.name`,
        });
      }
      startTool(controller, state, tool);
      tool.ended = true;
      controller.enqueue({
        type: "tool_end",
        location: { choice: state.index, content: tool.sourceIndex },
      });
    }
  }

  function finalize(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (finalized || errored) return;
    finalized = true;

    // Close every open block so start/delta/end stay paired (SR-002).
    for (const state of choices.values()) {
      if (state.ended) continue;
      flushPendingTools(controller, state);
      ensureStarted(controller, state);
      closeAllBlocks(controller, state);
      state.ended = true;
      controller.enqueue({
        type: "choice_end",
        choice: state.index,
        finishReason: state.finishReason,
      });
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

  function hasPayload(delta: ChatChoiceChunk["delta"]): boolean {
    if (!delta) return false;
    return (
      delta.role === "assistant" ||
      delta.content !== undefined ||
      delta.refusal !== undefined ||
      Array.isArray(delta.tool_calls) ||
      (reasoningField !== undefined &&
        typeof delta[reasoningField] === "string" &&
        delta[reasoningField] !== "")
    );
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

      const chunkChoices = Array.isArray(chunk.choices) ? chunk.choices : [];

      if (!messageStarted && chunkChoices.some((c) => hasPayload(c.delta))) {
        messageStarted = true;
        controller.enqueue({
          type: "message_start",
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          model: typeof chunk.model === "string" ? chunk.model : undefined,
        });
      }

      for (let i = 0; i < chunkChoices.length; i++) {
        const raw = chunkChoices[i];
        const index = typeof raw.index === "number" ? raw.index : i;
        const delta = raw.delta ?? {};
        const state = choiceState(index);

        const finished = typeof raw.finish_reason === "string" && raw.finish_reason !== null;
        if (hasPayload(delta) || finished) ensureStarted(controller, state);

        if (
          reasoningField &&
          typeof delta[reasoningField] === "string" &&
          delta[reasoningField] !== ""
        ) {
          startReasoning(controller, state);
          controller.enqueue({
            type: "reasoning_delta",
            location: { choice: index, content: 0 },
            text: delta[reasoningField] as string,
          });
        }

        if (typeof delta.content === "string" && delta.content !== "") {
          startText(controller, state);
          controller.enqueue({
            type: "text_delta",
            location: { choice: index, content: 0 },
            text: delta.content,
          });
        }

        if (typeof delta.refusal === "string" && delta.refusal !== "") {
          startRefusal(controller, state);
          controller.enqueue({
            type: "refusal_delta",
            location: { choice: index, content: 0 },
            text: delta.refusal,
          });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const toolIndex = typeof tc.index === "number" ? tc.index : 0;
            const tool = state.tools.get(toolIndex) ?? {
              sourceIndex: toolIndex,
              pendingArguments: "",
              started: false,
              ended: false,
              deferredReported: false,
            };
            if (typeof tc.id === "string") tool.id = tc.id;
            if (tc.function && typeof tc.function.name === "string") {
              tool.name = tc.function.name;
            }
            const args = tc.function?.arguments;
            if (typeof args === "string" && args !== "") {
              if (tool.started) {
                controller.enqueue({
                  type: "tool_arguments_delta",
                  location: { choice: index, content: toolIndex },
                  partialJson: args,
                });
              } else {
                if (!tool.deferredReported) {
                  tool.deferredReported = true;
                  // A provider declared to split tool metadata needs no warning;
                  // it is the declared dialect (GAP-014).
                  if (!profile.capabilities.stream?.maySplitToolMetadata) {
                    warn({
                      code: "tool_metadata_deferred",
                      message: `Tool call index ${toolIndex} delivered arguments before its name; buffered until tool_start`,
                      fidelity: "COMPATIBLE",
                      field: `tool_calls[${toolIndex}].function.arguments`,
                    });
                  }
                }
                tool.pendingArguments += args;
              }
            }
            if (!tool.started && tool.name !== undefined) {
              startTool(controller, state, tool);
            }
            state.tools.set(toolIndex, tool);
          }
        }

        if (finished) {
          finishObserved = true;
          state.finishReason = FINISH_REASON_MAP[raw.finish_reason as string] ?? "unknown";
          cachedFinishReason = state.finishReason;
          flushPendingTools(controller, state);
          closeAllBlocks(controller, state);
          state.ended = true;
          controller.enqueue({
            type: "choice_end",
            choice: index,
            finishReason: state.finishReason,
          });
        }
      }

      const usage = parseUsage(chunk.usage, profile.capabilities.usage);
      if (usage) {
        if (finishObserved) usageAfterFinish = true;
        cachedUsage = usage;
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
  // Canonical inputTokens is pure input, EXCLUDING cache tokens; OpenAI's
  // prompt_tokens includes them, so split cached_tokens out when reported.
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
  if (typeof u.completion_tokens === "number") parsed.outputTokens = u.completion_tokens;
  const details: Record<string, unknown> = {};
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
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
