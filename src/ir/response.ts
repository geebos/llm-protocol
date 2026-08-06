/**
 * Canonical response (FR-003).
 *
 * id/model are optional: providers that omit them leave the fields absent
 * rather than receiving fabricated values.
 */
import type { ContentPart } from "./types.js";
import type { CanonicalFinishReason } from "./finish-reason.js";
import type { CanonicalUsage } from "./usage.js";

export interface CanonicalResponse {
  id?: string;
  model?: string;
  content: ContentPart[];
  finishReason?: CanonicalFinishReason;
  usage?: CanonicalUsage;
  /** Provider-native response metadata (e.g. `created`), preserved opaque. */
  extensions?: Record<string, unknown>;
}
