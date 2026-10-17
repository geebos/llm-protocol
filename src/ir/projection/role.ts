/**
 * Role projection helpers (docs/07 §5.2.1, DEC-11).
 *
 * Role/position projection is capability-driven and fail-closed: a role the
 * target cannot express is a `required` field that cannot be dropped, so it
 * raises a `non_droppable_field` error instead of being silently rewritten.
 */
import { TranslationError } from "../../errors.js";
import type { ApiFormat } from "../../formats.js";
import type { MessageRole } from "../types.js";

export function fieldProjectionError(
  field: string,
  targetFormat: ApiFormat,
): TranslationError {
  return new TranslationError({
    kind: "unsupported",
    code: "non_droppable_field",
    message: `field "${field}" is not representable in ${targetFormat} and cannot be dropped`,
  });
}

export function roleProjectionError(
  role: MessageRole,
  targetFormat: ApiFormat,
): TranslationError {
  return fieldProjectionError(`role:${role}`, targetFormat);
}
