/**
 * Four-state projection outcome (docs/07.ir-native-codec.md §6.2).
 *
 * The codec, not the Planner, decides whether the target can express a field:
 *
 * - `rendered`     exact render (structure/semantics correspond)
 * - `transformed`  lossless transform (provably semantics-equivalent)
 * - `adapted`      feature adaptation (a user-authorized semantic approximation)
 * - `unsupported`  the target cannot express the field
 *
 * The Planner only adjudicates the last two against the field policy (§6.2).
 */
import type { DropRecord } from "./drop-record.js";

export type ProjectionOutcome =
  | { readonly kind: "rendered" }
  | { readonly kind: "transformed" }
  | { readonly kind: "adapted"; readonly lossy: boolean }
  | { readonly kind: "unsupported"; readonly cause: DropRecord["cause"] };
