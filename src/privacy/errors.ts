/**
 * Privacy guard errors.
 *
 * A guard error means the request cannot be safely transformed (fail-closed in
 * `strict` mode). It carries only a stable code and a structural path, never
 * any raw value, placeholder or user text (INV-3).
 */
import type { PrivacyWarningCode } from "./types.js";

export class PrivacyGuardError extends Error {
  readonly code: PrivacyWarningCode;
  readonly field?: string;

  constructor(code: PrivacyWarningCode, message: string, field?: string) {
    super(message);
    this.name = "PrivacyGuardError";
    this.code = code;
    this.field = field;
  }
}

export function guard(
  code: PrivacyWarningCode,
  message: string,
  field?: string,
): never {
  throw new PrivacyGuardError(code, message, field);
}
