/**
 * Canonical usage -> unified usage mapping (05.translate-api.md §7).
 *
 * Missing fields default to 0 rather than being fabricated; `undefined` is
 * returned only when no usage was observed at all.
 */
import type { CanonicalUsage } from "../ir/usage.js";
import type { UnifiedUsage } from "./types.js";

export function toUnifiedUsage(usage: CanonicalUsage | undefined): UnifiedUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheCreationTokens ?? 0,
  };
}
