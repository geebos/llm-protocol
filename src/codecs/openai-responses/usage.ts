/**
 * Responses usage parsing (responses.md §14.1/§14.3).
 *
 * Shared by the non-streaming response codec and the SSE parser: Responses
 * returns usage in the terminal event (`response.completed` /
 * `response.incomplete` both carry `usage`), and the stream must aggregate it
 * into a canonical `usage` event before `message_end` (review round 2: the
 * terminal usage was previously dropped entirely).
 *
 * Responses `input_tokens` includes `cached_tokens` as a subset (like Chat);
 * canonical `inputTokens` is pure input, cache split out.
 */
import type { CanonicalUsage } from "../../ir/usage.js";

export function parseUsage(usage: unknown): CanonicalUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const parsed: CanonicalUsage = {};
  const inputTokens = u.input_tokens;
  if (typeof inputTokens === "number") {
    const details = u.input_tokens_details as { cached_tokens?: unknown } | undefined;
    const cached =
      details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
    parsed.inputTokens = Math.max(0, inputTokens - cached);
    if (cached > 0) parsed.cacheReadTokens = cached;
  }
  if (typeof u.output_tokens === "number") parsed.outputTokens = u.output_tokens;
  const details: Record<string, unknown> = {};
  for (const key of ["input_tokens_details", "output_tokens_details"]) {
    if (u[key] !== undefined) details[key] = u[key];
  }
  const outputDetails = u.output_tokens_details as
    | { reasoning_tokens?: unknown }
    | undefined;
  if (outputDetails && typeof outputDetails.reasoning_tokens === "number") {
    parsed.reasoningTokens = outputDetails.reasoning_tokens;
  }
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
