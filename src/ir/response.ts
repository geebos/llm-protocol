/**
 * Canonical response (FR-003, docs/07 §5.3).
 *
 * A response carries one or more choices. Chat `n > 1` produces multiple
 * choices; Anthropic always produces one. `id`/`model` are optional: providers
 * that omit them leave the fields absent rather than receiving fabricated
 * values.
 */
import type { ContentPart } from "./types.js";
import type { NativeChoice, NativeResponse } from "./native/index.js";
import type { CanonicalFinishReason } from "./finish-reason.js";
import type { CanonicalUsage } from "./usage.js";

export interface CanonicalChoice {
  index: number;
  content: ContentPart[];
  finishReason?: CanonicalFinishReason;
  /** Protocol-native choice fields (e.g. Chat per-choice `logprobs`). */
  native?: NativeChoice;
}

export interface CanonicalResponse {
  id?: string;
  model?: string;
  choices: CanonicalChoice[];
  usage?: CanonicalUsage;
  /** Protocol-native response fields (docs/07). */
  native?: NativeResponse;
  /** Provider-native response metadata (e.g. `created`), preserved opaque. */
  extensions?: Record<string, unknown>;
}
