/**
 * Fidelity calculation (docs/07.ir-native-codec.md §9.1, R-13/R-23).
 *
 * Fidelity describes the quality of a completed conversion; it never decides
 * whether a conversion is allowed. Drops and lossy feature adaptations must be
 * reflected, otherwise an `EXACT` label could accompany lost fields.
 */
import type { Fidelity, TranslationWarning } from "../fidelity.js";
import type { DropRecord, FeatureAdaptationRecord } from "./drop-record.js";

const RANK: Record<Fidelity, number> = {
  EXACT: 0,
  COMPATIBLE: 1,
  LOSSY: 2,
  UNSUPPORTED: 3,
};

export function worstFidelity(warnings: TranslationWarning[]): Fidelity {
  let worst: Fidelity = "EXACT";
  for (const warning of warnings) {
    if (RANK[warning.fidelity] > RANK[worst]) worst = warning.fidelity;
  }
  return worst;
}

export function calculateFidelity(
  warnings: TranslationWarning[],
  drops: DropRecord[],
  adaptations: FeatureAdaptationRecord[],
): Fidelity {
  const base = worstFidelity(warnings);
  // A more severe warning (e.g. UNSUPPORTED) is never downgraded.
  if (base === "UNSUPPORTED") return base;
  if (drops.length > 0 || adaptations.some((a) => a.lossy)) return "LOSSY";
  // A non-lossy feature adaptation is still not a pure render.
  if (adaptations.length > 0 && base === "EXACT") return "COMPATIBLE";
  return base;
}
