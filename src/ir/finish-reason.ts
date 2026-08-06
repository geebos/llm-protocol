/**
 * Canonical finish reason (FR-009).
 *
 * Unified vocabulary across Anthropic (`end_turn`, `tool_use`, `max_tokens`,
 * `stop_sequence`) and OpenAI Chat (`stop`, `tool_calls`, `length`,
 * `content_filter`). Unknown values must map to `unknown`, never be guessed.
 */
export type CanonicalFinishReason =
  | "end_turn"
  | "tool_call"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "refusal"
  | "unknown";
