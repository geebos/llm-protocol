/**
 * Translation policies (Appendix A.3, TH-004).
 *
 * Controls how lossy or unsupported constructs are handled. The default
 * configuration never silently drops: reasoning degradation is reported in the
 * TranslationReport. All policies are per-translate() options; nothing here
 * depends on model names.
 */
export interface TranslationPolicies {
  /** Unrecognized request/response fields. */
  unsupportedField: "reject" | "drop_with_warning" | "preserve_extension";
  /** Reasoning when the target has no representation (TH-004). */
  reasoning: "reject" | "drop_with_warning" | "provider_metadata";
  /** Unknown SSE events. */
  unknownStreamEvent: "ignore_with_warning" | "preserve_extension" | "reject";
  /** Tool arguments that never form valid JSON. */
  invalidToolArguments: "reject" | "buffer_until_valid";
  generateMissingIds: boolean;
}

export const DEFAULT_POLICIES: TranslationPolicies = {
  unsupportedField: "preserve_extension",
  reasoning: "drop_with_warning",
  unknownStreamEvent: "preserve_extension",
  invalidToolArguments: "reject",
  generateMissingIds: true,
};
