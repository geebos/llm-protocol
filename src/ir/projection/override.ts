/**
 * Policy overrides (docs/07.ir-native-codec.md §5.9).
 *
 * A caller may relax a `required` field to `droppable` for a specific path,
 * but only for the declared source/target pair and never for the hard
 * (unrecoverable-content) set.
 */
import type { ApiFormat } from "../../formats.js";
import { validationError } from "../../errors.js";
import type { ProjectionContext } from "./context.js";

/**
 * Path fragments whose loss must never be authorized by an override (§5.8
 * unrecoverable-content class: reasoning signature/encrypted content, tool-call
 * identity, refusal, opaque native). Match is a substring test so indexed paths
 * (`messages[0].content[1].reasoning.signature`) are covered.
 */
export const NON_RELAXABLE_SEGMENTS: readonly string[] = [
  "reasoning.signature",
  "reasoning.encryptedContent",
  "tool_call.id",
  "refusal",
  "opaque_native",
];

export interface PolicyOverride {
  /** Exact field path this override applies to. */
  path: string;
  /** Restrict to one source protocol; omit for any. */
  inputFormat?: ApiFormat;
  /** Restrict to one target protocol; omit for any. */
  outputFormat?: ApiFormat;
  /** Only `required -> droppable` relaxation is permitted. */
  policy: "droppable";
}

function touchesHardSegment(path: string): string | undefined {
  return NON_RELAXABLE_SEGMENTS.find((segment) => path.includes(segment));
}

/** Throw when an override is malformed or relaxes a hard-required field. */
export function validateOverride(override: PolicyOverride): void {
  if (!override.path) {
    throw validationError("policy override requires a non-empty path");
  }
  if (override.policy !== "droppable") {
    throw validationError("policy override may only relax required -> droppable");
  }
  const hard = touchesHardSegment(override.path);
  if (hard) {
    throw validationError(
      `policy override cannot relax required field ${override.path} (hard segment ${hard})`,
    );
  }
}

export function findOverride(
  overrides: readonly PolicyOverride[] | undefined,
  context: ProjectionContext,
  path: string,
): PolicyOverride | undefined {
  return overrides?.find(
    (override) =>
      override.path === path &&
      (override.inputFormat === undefined || override.inputFormat === context.inputFormat) &&
      (override.outputFormat === undefined || override.outputFormat === context.outputFormat),
  );
}
