/**
 * Canonical usage (FR-010).
 *
 * Missing values are never fabricated; `providerDetails` keeps provider-native
 * detail fields opaque. `totalTokens` is derived from input+output only when
 * both are present.
 */
export interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  providerDetails?: Record<string, unknown>;
}
