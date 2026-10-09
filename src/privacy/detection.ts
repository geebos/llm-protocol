/**
 * Span validation and adjudication (PR-005, §6.1/§6.2).
 *
 * A detection must be an integer UTF-16 range that does not split a surrogate
 * pair; `value` (when supplied) must match the text slice. Overlapping
 * detections are adjudicated fail-closed: the outermost span wins, equal spans
 * fall back to the highest recognizer priority, and genuine crossings are a
 * hard error.
 */
import type { Detection, PrivacyRecognizer } from "./types.js";
import { guard } from "./errors.js";
import { isValidType } from "./template.js";

export interface ValidatedDetection extends Detection {
  priority: number;
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

/** True when `index` falls between a surrogate pair. */
function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  return (
    HIGH_SURROGATE.test(text[index - 1]) && LOW_SURROGATE.test(text[index])
  );
}

export interface ValidateOptions {
  maxTypeLength: number;
  /** Recognizer priority attached to the detection. */
  priority: number;
  /** Structural field path, for diagnostics only. */
  field?: string;
}

/**
 * Validate one detection. Returns `undefined` when valid, otherwise a short
 * diagnostic token describing the failure.
 */
export function validateDetection(
  detection: Detection,
  text: string,
  options: ValidateOptions,
): string | undefined {
  const { start, end, type, value } = detection;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "non_integer_range";
  if (start < 0 || start >= end || end > text.length) return "out_of_range";
  if (typeof type !== "string" || !isValidType(type, options.maxTypeLength)) {
    return "invalid_type";
  }
  if (value !== undefined && value !== text.slice(start, end)) return "value_mismatch";
  if (splitsSurrogate(text, start) || splitsSurrogate(text, end)) {
    return "surrogate_split";
  }
  return undefined;
}

/**
 * Adjudicate overlapping detections into a deterministic, non-overlapping set
 * sorted by `start`. Throws `PrivacyGuardError("privacy_invalid_detection")`
 * when two detections genuinely cross.
 */
export function resolveSpans(detections: ValidatedDetection[]): ValidatedDetection[] {
  if (detections.length <= 1) return [...detections];
  const sorted = [...detections].sort(
    (a, b) => a.start - b.start || b.end - a.end || b.priority - a.priority,
  );
  const out: ValidatedDetection[] = [];
  let cluster: ValidatedDetection[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length) out.push(adjudicate(cluster));
    cluster = [];
    clusterEnd = -1;
  };

  for (const d of sorted) {
    if (cluster.length && d.start >= clusterEnd) flush();
    cluster.push(d);
    clusterEnd = Math.max(clusterEnd, d.end);
  }
  flush();
  return out.sort((a, b) => a.start - b.start);
}

function adjudicate(cluster: ValidatedDetection[]): ValidatedDetection {
  if (cluster.length === 1) return cluster[0];
  const minStart = Math.min(...cluster.map((d) => d.start));
  const maxEnd = Math.max(...cluster.map((d) => d.end));
  const allEqual = cluster.every((d) => d.start === minStart && d.end === maxEnd);
  if (allEqual) return highestPriority(cluster);
  const containers = cluster.filter((d) => d.start <= minStart && d.end >= maxEnd);
  if (containers.length === 1) return containers[0];
  if (containers.length > 1) return highestPriority(containers);
  guard(
    "privacy_invalid_detection",
    "Overlapping privacy detections cross without a containing span",
  );
}

/** Higher numeric priority wins (larger number = higher precedence). */
function highestPriority(list: ValidatedDetection[]): ValidatedDetection {
  return list.reduce((best, d) => (d.priority > best.priority ? d : best));
}

/** Validate and attach priority to a recognizer's raw detections. */
export function validated(
  detection: Detection,
  text: string,
  recognizer: PrivacyRecognizer,
  maxTypeLength: number,
  field?: string,
): { ok: true; detection: ValidatedDetection } | { ok: false; reason: string } {
  const reason = validateDetection(detection, text, {
    maxTypeLength,
    priority: recognizer.priority,
    field,
  });
  if (reason) return { ok: false, reason };
  return { ok: true, detection: { ...detection, priority: recognizer.priority } };
}
