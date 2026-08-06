/**
 * Translation fidelity model (5.2, FR-008).
 *
 * Any LOSSY or UNSUPPORTED decision must produce a warning entry so the
 * pipeline can surface it in the trace/report. Nothing may be silently lost.
 */

export type Fidelity = "EXACT" | "COMPATIBLE" | "LOSSY" | "UNSUPPORTED";

export interface TranslationWarning {
  code: string;
  message: string;
  fidelity: Fidelity;
  /** Protocol-relative field path, when applicable. */
  field?: string;
}
