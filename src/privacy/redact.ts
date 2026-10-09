/**
 * Detection collection, deterministic allocation and replacement (§6).
 *
 * Recognizer results are collected asynchronously (they may complete out of
 * order) but the request is THEN transformed serially in IR document order, so
 * placeholder numbering never depends on completion order (PR-009/PR-018,
 * INV-8). Replacement runs back-to-front over a region so offsets never drift.
 */
import type { PrivacyRecognizer, PrivacyWarning } from "./types.js";
import type { ResolvedPrivacyConfig } from "./config.js";
import { PrivacyGuardError, guard } from "./errors.js";
import { resolveSpans, validated, type ValidatedDetection } from "./detection.js";
import type { PrivacySession } from "./session.js";

/**
 * A detection spanning more than one text part where any overlapped part
 * carries a `cache` breakpoint cannot be redacted safely (V1 does not reorder
 * cache boundaries), so it is rejected (§7.2 rule 5).
 */
function crossesCachedPart(region: Region, start: number, end: number): boolean {
  const segments = region.segments;
  let offset = 0;
  let overlapped = 0;
  let cached = false;
  for (const segment of segments) {
    const segmentLength = segment.get().length;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > start && offset < end) {
      overlapped++;
      if (segment.cache) cached = true;
    }
    offset = segmentEnd;
    if (offset >= end) break;
  }
  return overlapped > 1 && cached;
}

export interface TextSegment {
  get(): string;
  set(value: string): void;
  /** Whether this part carries prompt-cache metadata (PR-017). */
  cache?: boolean;
}

export interface Region {
  channel: Parameters<PrivacyRecognizer["recognize"]>[1]["channel"];
  path: string;
  segments: TextSegment[];
  /** `true` -> only detection runs; any hit is a rejection. */
  detectOnly?: boolean;
  rejectCode?: PrivacyWarning["code"];
  /** Serialize the mutated structure back to a field (JSON tool arguments). */
  serialize?: () => string;
  /** Write the recomputed field text (JSON tool arguments). */
  write?: (text: string) => void;
}

export interface RedactResult {
  redacted: number;
  invalidDetections: number;
  degraded: boolean;
  channels: Set<string>;
  /** Texts from `allow` channels (used by EgressVerify). */
  allowTexts: string[];
  /** Sanitized warnings produced during redaction. */
  warnings: PrivacyWarning[];
  /** Extension paths whose string values were actually transformed. */
  transformedExtensions: string[];
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

export function regionText(region: Region): string {
  return region.segments.map((s) => s.get()).join("");
}

/** Apply replacements to a region's segments, back-to-front. */
function applyReplacements(segments: TextSegment[], reps: Replacement[]): void {
  const texts = segments.map((s) => s.get());
  const offsets: number[] = [];
  let acc = 0;
  for (const t of texts) {
    offsets.push(acc);
    acc += t.length;
  }
  const ops: { seg: number; start: number; end: number; insert?: string }[] = [];
  for (const rep of reps) {
    let first = true;
    for (let i = 0; i < texts.length; i++) {
      const segStart = offsets[i];
      const segEnd = segStart + texts[i].length;
      if (segEnd <= rep.start) continue;
      if (segStart >= rep.end) break;
      const start = Math.max(0, rep.start - segStart);
      const end = Math.min(texts[i].length, rep.end - segStart);
      ops.push({ seg: i, start, end, insert: first ? rep.value : undefined });
      first = false;
    }
  }
  for (let i = 0; i < segments.length; i++) {
    const segOps = ops.filter((o) => o.seg === i).sort((a, b) => b.start - a.start);
    if (segOps.length === 0) continue;
    let text = texts[i];
    for (const op of segOps) {
      text = text.slice(0, op.start) + (op.insert ?? "") + text.slice(op.end);
    }
    segments[i].set(text);
  }
}

async function collectDetections(
  region: Region,
  text: string,
  config: ResolvedPrivacyConfig,
  sessionId: string,
  state: { invalid: number; degraded: boolean; warnings: PrivacyWarning[] },
): Promise<ValidatedDetection[]> {
  const recognizers = [...config.recognizers].sort((a, b) => a.priority - b.priority);
  const outcomes = await Promise.all(
    recognizers.map(async (r) => {
      try {
        const dets = await r.recognize(text, {
          channel: region.channel,
          path: region.path,
          sessionId,
        });
        return { recognizer: r, detections: Array.isArray(dets) ? dets : [] };
      } catch {
        if (config.recognition.onRecognizerError === "passthrough_with_warning") {
          state.degraded = true;
          state.warnings.push({
            code: "privacy_recognizer_failed",
            message: "A privacy recognizer failed; its detections were skipped",
            field: region.path,
          });
          return { recognizer: r, detections: [] };
        }
        throw new PrivacyGuardError(
          "privacy_recognizer_failed",
          "A privacy recognizer failed",
          region.path,
        );
      }
    }),
  );

  const out: ValidatedDetection[] = [];
  for (const { recognizer, detections } of outcomes) {
    for (const d of detections) {
      const result = validated(d, text, recognizer, config.streaming.maxTypeLength, region.path);
      if (!result.ok) {
        if (config.recognition.onInvalidDetection === "drop_with_warning") {
          state.invalid++;
          state.degraded = true;
          state.warnings.push({
            code: "privacy_invalid_detection",
            message: "An invalid privacy detection was dropped",
            field: region.path,
          });
          continue;
        }
        throw new PrivacyGuardError(
          "privacy_invalid_detection",
          "An invalid privacy detection was rejected",
          region.path,
        );
      }
      out.push(result.detection);
    }
  }
  return resolveSpans(out);
}

/**
 * Transform regions in document order. `extraHaystack` carries any
 * model-visible text not represented by a region (e.g. default-allow
 * extensions) for collision scanning.
 */
export async function redactRegions(
  regions: Region[],
  session: PrivacySession,
  config: ResolvedPrivacyConfig,
  extraHaystack: string[] = [],
): Promise<RedactResult> {
  const state = {
    invalid: 0,
    degraded: false,
    warnings: [] as PrivacyWarning[],
  };
  const collected = new Map<Region, { text: string; detections: ValidatedDetection[]; action: "redact" | "reject" }>();
  const channels = new Set<string>();

  for (const region of regions) {
    const text = regionText(region);
    if (
      region.channel === "tool_arguments" &&
      text.length > config.streaming.maxToolArgumentBytes
    ) {
      guard(
        "privacy_buffer_overflow",
        "Tool arguments exceed the configured privacy limit",
        region.path,
      );
    }
    if (region.detectOnly) {
      channels.add(region.channel);
      const detections = await collectDetections(region, text, config, session.id, state);
      if (detections.length) {
        guard(
          region.rejectCode ?? "privacy_uncovered_channel",
          "Sensitive content detected in a non-redacted privacy channel",
          region.path,
        );
      }
      continue;
    }
    const action = regionAction(region);
    if (action === "allow") continue;
    channels.add(region.channel);
    const detections = await collectDetections(region, text, config, session.id, state);
    if (action === "reject") {
      if (detections.length) {
        guard(
          region.rejectCode ?? "privacy_uncovered_channel",
          "Sensitive content detected in a rejected privacy channel",
          region.path,
        );
      }
      continue;
    }
    collected.set(region, { text, detections, action });
  }

  const haystack = [
    ...regions.filter((r) => !r.detectOnly).map((r) => regionText(r)),
    ...extraHaystack,
  ].join("\u0000");

  let redacted = 0;
  const allowTexts: string[] = [];
  const transformedExtensions = new Set<string>();

  for (const region of regions) {
    const entry = collected.get(region);
    if (!entry) continue;
    const reps: Replacement[] = [];
    for (const detection of entry.detections) {
      const original = entry.text.slice(detection.start, detection.end);
      if (original === "") continue;
      if (crossesCachedPart(region, detection.start, detection.end)) {
        guard(
          "privacy_cross_part_cache_break",
          "A sensitive range crosses a prompt-cache breakpoint",
          region.path,
        );
      }
      // Already-registered placeholder literal occurring as source text is
      // skipped (never re-mapped) with a warning (Appendix C rule 2).
      if (session.lookupPlaceholder(original)) {
        state.warnings.push({
          code: "privacy_channel_skipped",
          message: "Source text equals an already-registered placeholder; left untouched",
          field: region.path,
        });
        continue;
      }
      const mapping = session.getOrCreate(detection.type, original);
      if (haystack.includes(mapping.placeholder)) {
        guard(
          "privacy_placeholder_collision",
          "A generated placeholder collides with existing model-visible text",
          region.path,
        );
      }
      reps.push({ start: detection.start, end: detection.end, value: mapping.placeholder });
      redacted++;
      channels.add(region.channel);
    }
    if (reps.length) {
      applyReplacements(region.segments, reps);
      if (region.serialize && region.write) region.write(region.serialize());
      if (region.channel === "extensions") transformedExtensions.add(region.path);
    }
  }

  // Collect allow-channel text for EgressVerify (already-registered originals
  // appearing there are permitted by policy).
  for (const region of regions) {
    if (region.detectOnly) continue;
    if (regionAction(region) === "allow") allowTexts.push(regionText(region));
  }

  return {
    redacted,
    invalidDetections: state.invalid,
    degraded: state.degraded,
    channels,
    allowTexts: [...allowTexts, ...extraHaystack],
    warnings: state.warnings,
    transformedExtensions: [...transformedExtensions],
  };
}

const actionByRegion = new WeakMap<Region, "redact" | "allow" | "reject">();

export function setRegionAction(region: Region, action: "redact" | "allow" | "reject"): Region {
  actionByRegion.set(region, action);
  return region;
}

function regionAction(region: Region): "redact" | "allow" | "reject" {
  return actionByRegion.get(region) ?? "redact";
}
