/**
 * Drop / feature-adaptation audit records (docs/07.ir-native-codec.md §6.3, §6.2.1).
 *
 * Records never carry raw field values or native objects (privacy).
 */
import type { ApiFormat } from "../../formats.js";
import type { ProjectionPhase } from "./context.js";

export interface DropRecord {
  phase: ProjectionPhase;
  path: string;
  /** Current projection input direction (not the original route). */
  sourceFormat: ApiFormat;
  targetFormat: ApiFormat;
  /** Why the field cannot be forwarded (expression capability). */
  cause: "unsupported_by_target" | "unknown_field" | "unrepresentable";
  /** Why dropping it was permitted (loss authorization). */
  authorization: "policy_droppable" | "override_droppable";
}

/**
 * A user-authorized semantic approximation (e.g.
 * `cache_control -> prompt_cache_key`). Distinct from a field drop: it is a
 * feature the caller explicitly enabled, and it is never lossless-EXACT.
 */
export interface FeatureAdaptationRecord {
  phase: ProjectionPhase;
  path: string;
  feature: string;
  lossy: boolean;
  sourceFormat: ApiFormat;
  targetFormat: ApiFormat;
}
