/**
 * Canonical response (FR-003).
 *
 * id/model are optional: providers that omit them leave the fields absent
 * rather than receiving fabricated values.
 */
import type { ContentPart } from "./types.js";
import type { CanonicalFinishReason } from "./finish-reason.js";
import type { CanonicalUsage } from "./usage.js";

/**
 * Canonical response status (responses.md §8.2, v0.5 P1-2).
 *
 * Independent axis from `finishReason`: status answers whether the response
 * completed; finishReason answers why the provider stopped. Only explicit
 * truncation (max_tokens) yields `incomplete`; unknown finish reasons with a
 * successful return stay `completed` (with a warning).
 */
export type CanonicalResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export interface CanonicalResponse {
  id?: string;
  model?: string;
  content: ContentPart[];
  finishReason?: CanonicalFinishReason;
  status?: CanonicalResponseStatus;
  usage?: CanonicalUsage;
  /** Provider-native response metadata (e.g. `created`), preserved opaque. */
  extensions?: Record<string, unknown>;
}
