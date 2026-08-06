/**
 * Unified error model (FR-011).
 *
 * Every failure surfaced by the core maps to one of these kinds so callers and
 * the reverse error codecs can translate it without protocol knowledge.
 */

export type ErrorKind =
  | "validation"
  | "upstream"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "stream_protocol"
  | "unsupported";

export interface CanonicalError {
  kind: ErrorKind;
  message: string;
  status?: number;
  /** Provider-native error code/type, kept as an opaque string. */
  providerCode?: string;
  requestId?: string;
  cause?: unknown;
}

export class TranslationError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  override readonly cause?: unknown;

  constructor(error: CanonicalError) {
    super(error.message);
    this.name = "TranslationError";
    this.kind = error.kind;
    this.status = error.status;
    this.providerCode = error.providerCode;
    this.requestId = error.requestId;
    this.cause = error.cause;
  }
}

export function validationError(message: string): TranslationError {
  return new TranslationError({ kind: "validation", message });
}

export function unsupportedError(message: string): TranslationError {
  return new TranslationError({ kind: "unsupported", message });
}
