/**
 * Response Envelope Builder (responses.md §13.1.2, D-14).
 *
 * Holds the target Responses envelope state for one response lifecycle:
 * - `created_at` is allocated exactly once and stays identical across the SSE
 *   snapshot and the terminal response;
 * - `output_item.added` -> OutputItemState.status = "in_progress";
 * - `output_item.done` -> "completed" (or "incomplete" when truncated);
 * - the terminal `output[]` equals the done items exactly (order, id, payload).
 *
 * When the source lacks a timestamp (e.g. Anthropic), the caller passes a
 * translator-owned structural timestamp; the origin is trace-only.
 */
import type { CanonicalUsage } from "../../ir/usage.js";

export type ResponsesStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export type OutputItemType =
  | "message"
  | "reasoning"
  | "function_call"
  | "custom_tool_call";

export type OutputItemStatus = "in_progress" | "completed" | "incomplete";

export interface OutputItemState {
  id: string;
  type: OutputItemType;
  status: OutputItemStatus;
  outputIndex: number;
  /** Protocol wire payload for the item (parts / reasoning / call params). */
  payload?: unknown;
}

export interface ResponseEnvelopeState {
  id: string;
  object: "response";
  createdAt: number;
  completedAt?: number;
  status: ResponsesStatus;
  model?: string;
  error?: unknown;
  incompleteDetails?: unknown;
  output: OutputItemState[];
  usage?: CanonicalUsage;
  /** Request-side config the target still echoes back. */
  requestDerived?: Record<string, unknown>;
}

export class ResponseEnvelopeBuilder {
  private readonly state: ResponseEnvelopeState;

  constructor(id: string, createdAt: number, model?: string) {
    this.state = {
      id,
      object: "response",
      createdAt,
      status: "queued",
      model,
      output: [],
    };
  }

  /** `output_item.added`: create the item as in_progress, ordered by index. */
  addItem(item: OutputItemState): void {
    const existing = this.state.output.find((o) => o.id === item.id);
    if (existing) {
      existing.status = item.status;
      existing.payload = item.payload ?? existing.payload;
      return;
    }
    this.state.output.push({ ...item });
    this.state.output.sort((a, b) => a.outputIndex - b.outputIndex);
  }

  /**
   * `output_item.done`: completed, or incomplete when truncated. Accepts the
   * final wire payload so the terminal `output[]` matches the done item
   * exactly (review P0-3, §13.1.2 rule 3).
   */
  completeItem(
    itemId: string,
    options?: { truncated?: boolean; payload?: unknown },
  ): void {
    const item = this.state.output.find((o) => o.id === itemId);
    if (!item) return;
    item.status = options?.truncated ? "incomplete" : "completed";
    if (options?.payload !== undefined) item.payload = options.payload;
  }

  setStatus(status: ResponsesStatus, details?: { error?: unknown; incompleteDetails?: unknown }): void {
    this.state.status = status;
    if (details?.error !== undefined) this.state.error = details.error;
    if (details?.incompleteDetails !== undefined) {
      this.state.incompleteDetails = details.incompleteDetails;
    }
    if (status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled") {
      this.state.completedAt ??= Math.floor(Date.now() / 1000);
    }
  }

  setUsage(usage: CanonicalUsage): void {
    this.state.usage = usage;
  }

  setModel(model: string): void {
    this.state.model = model;
  }

  setId(id: string): void {
    this.state.id = id;
  }

  setRequestDerived(value: Record<string, unknown>): void {
    this.state.requestDerived = value;
  }

  get id(): string {
    return this.state.id;
  }

  get status(): ResponsesStatus {
    return this.state.status;
  }

  get output(): OutputItemState[] {
    return this.state.output;
  }

  snapshot(): ResponseEnvelopeState {
    return JSON.parse(JSON.stringify(this.state)) as ResponseEnvelopeState;
  }
}

/** Serialize the envelope to the Responses response wire shape. */
export function envelopeToWire(
  envelope: ResponseEnvelopeState,
): Record<string, unknown> {
  return {
    id: envelope.id,
    object: "response",
    created_at: envelope.createdAt,
    ...(envelope.completedAt !== undefined
      ? { completed_at: envelope.completedAt }
      : {}),
    status: envelope.status,
    error: envelope.error ?? null,
    incomplete_details: envelope.incompleteDetails ?? null,
    instructions: envelope.requestDerived?.instructions ?? null,
    max_output_tokens: envelope.requestDerived?.max_output_tokens ?? null,
    model: envelope.model ?? null,
    output: envelope.output.map(itemToWire),
    parallel_tool_calls: envelope.requestDerived?.parallel_tool_calls ?? true,
    previous_response_id: envelope.requestDerived?.previous_response_id ?? null,
    reasoning: envelope.requestDerived?.reasoning ?? null,
    store: envelope.requestDerived?.store ?? false,
    temperature: envelope.requestDerived?.temperature ?? null,
    text: envelope.requestDerived?.text ?? null,
    tool_choice: envelope.requestDerived?.tool_choice ?? "auto",
    tools: envelope.requestDerived?.tools ?? [],
    top_p: envelope.requestDerived?.top_p ?? null,
    truncation: envelope.requestDerived?.truncation ?? "disabled",
    usage: envelope.usage ? usageToWire(envelope.usage) : null,
    user: envelope.requestDerived?.user ?? null,
    metadata: envelope.requestDerived?.metadata ?? {},
  };
}

/** Canonical usage -> Responses usage wire shape (§14.1). */
export function usageToWire(usage: CanonicalUsage): Record<string, unknown> {
  const cacheTotal =
    (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const inputTokens =
    usage.inputTokens !== undefined && cacheTotal > 0
      ? usage.inputTokens + cacheTotal
      : usage.inputTokens;
  const inputDetails: Record<string, unknown> = {};
  if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
    inputDetails.cached_tokens = usage.cacheReadTokens;
  }
  const outputDetails: Record<string, unknown> = {};
  if (usage.reasoningTokens !== undefined) {
    outputDetails.reasoning_tokens = usage.reasoningTokens;
  }
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(Object.keys(inputDetails).length ? { input_tokens_details: inputDetails } : {}),
    ...(Object.keys(outputDetails).length ? { output_tokens_details: outputDetails } : {}),
    ...(usage.providerDetails ?? {}),
  };
}

function itemToWire(item: OutputItemState): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    status: item.status,
  };
  if (item.payload && typeof item.payload === "object") {
    return { ...base, ...(item.payload as Record<string, unknown>) };
  }
  return base;
}
