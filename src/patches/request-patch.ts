/**
 * Client-supplied request patches.
 *
 * A patch inspects the final target-protocol request body — already rendered by
 * the target codec, including cache-affinity rewrites — and returns the body to
 * send upstream. Patches run in the order supplied for both streaming and
 * non-streaming calls, and before egress verification, so what is verified is
 * exactly what is sent.
 *
 * Patches are a last-resort escape hatch for provider quirks the capability
 * model cannot express; they must not be used to smuggle credentials.
 */
import { TranslationError, validationError } from "../errors.js";

/** A patch over the outbound (target-protocol) request body. */
export interface RequestPatch {
  /**
   * Gate evaluated before `apply`, over the request as it stands when the patch
   * is reached (i.e. after earlier patches). Skipped when it returns false;
   * absent means "apply to every request".
   */
  filter?: (request: Readonly<Record<string, unknown>>) => boolean;
  /** Returns the replacement body; must not mutate the argument. */
  apply: (request: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/**
 * Apply `patches` in order. Each patch sees the previous patch's output.
 *
 * A failing or ill-typed patch is reported as a `validation` error naming its
 * position, so a caller bug never looks like an upstream failure.
 */
export function applyRequestPatches(
  payload: unknown,
  patches: readonly RequestPatch[],
): Record<string, unknown> {
  let current = asRequestObject(payload, "rendered request");
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    try {
      if (patch.filter !== undefined && !patch.filter(current)) continue;
      current = asRequestObject(patch.apply(current), `request patch #${i + 1}`);
    } catch (err) {
      if (err instanceof TranslationError) throw err;
      throw new TranslationError({
        kind: "validation",
        message: `Request patch #${i + 1} failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        cause: err,
      });
    }
  }
  return current;
}

function asRequestObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw validationError(`${label} must be a JSON object`);
}
