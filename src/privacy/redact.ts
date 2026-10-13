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
import { containsShape, escapeLiteralWithCount } from "./escape.js";
import type { CompiledTemplate } from "./template.js";

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
  /**
   * Whether literal text in this region may be prefix-escaped. Structural /
   * opaque fields (JSON keys, tool ids, machine fields) set `false`: a shape
   * literal there cannot be escaped, so it is rejected instead (E4).
   */
  escapable?: boolean;
  /**
   * Whether this region participates in the placeholder-collision scan.
   * Reasoning sets `false`: its tokens are legitimate references produced by
   * the model (signature-protected), its text is never restored, and any
   * string the model puts there can equally appear in restored output — so an
   * exact token match there is not a provenance conflict (docs/06 §11).
   */
  collisionScan?: boolean;
  /** Serialize the mutated structure back to a field (JSON tool arguments). */
  serialize?: () => string;
  /** Write the recomputed field text (JSON tool arguments). */
  write?: (text: string) => void;
}

export interface RedactResult {
  redacted: number;
  /** Literal shapes prefix-escaped during this request (Appendix B). */
  escaped: number;
  invalidDetections: number;
  degraded: boolean;
  channels: Set<string>;
  /** Texts from `allow` channels (used by EgressVerify). */
  allowTexts: string[];
  /**
   * Model-visible texts that opt out of collision/foreign-shape scanning
   * (`collisionScan: false`, e.g. reasoning): never restored, so a shape
   * literal there is harmless (used by EgressVerify).
   */
  exemptTexts: string[];
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

/** Index of the segment containing global position `pos`. */
function segmentIndexAt(offsets: number[], texts: string[], pos: number): number {
  for (let i = 0; i < texts.length; i++) {
    if (pos < offsets[i] + texts[i].length) return i;
  }
  return texts.length - 1;
}

/**
 * Apply replacements to a region's segments and escape the literal gaps.
 *
 * The region text is walked in global coordinates: detection spans are replaced
 * once (in the segment where they start) and every uncovered range is escaped
 * per segment when `doEscape` is set (docs/06 §6.1). Returns whether any
 * segment changed. Escaping only applies to `literal` provenance; generated
 * tokens are inserted verbatim (INV-E4).
 */
function transformSegments(
  segments: TextSegment[],
  reps: Replacement[],
  compiled: CompiledTemplate,
  doEscape: boolean,
): { changed: boolean; escaped: number } {
  const texts = segments.map((s) => s.get());
  const offsets: number[] = [];
  let total = 0;
  for (const t of texts) {
    offsets.push(total);
    total += t.length;
  }

  const sorted = [...reps].sort((a, b) => a.start - b.start);
  const chunks: { start: number; end: number; insert?: string }[] = [];
  let g = 0;
  for (const rep of sorted) {
    if (rep.start > g) chunks.push({ start: g, end: rep.start });
    chunks.push({ start: rep.start, end: rep.end, insert: rep.value });
    g = rep.end;
  }
  if (g < total) chunks.push({ start: g, end: total });

  const outs = segments.map(() => "");
  let escaped = 0;
  for (const chunk of chunks) {
    if (chunk.insert !== undefined) {
      outs[segmentIndexAt(offsets, texts, chunk.start)] += chunk.insert;
      continue;
    }
    for (let i = 0; i < segments.length; i++) {
      const segStart = offsets[i];
      const segEnd = segStart + texts[i].length;
      if (segEnd <= chunk.start) continue;
      if (segStart >= chunk.end) break;
      const localStart = Math.max(0, chunk.start - segStart);
      const localEnd = Math.min(texts[i].length, chunk.end - segStart);
      const piece = texts[i].slice(localStart, localEnd);
      if (doEscape) {
        const encoded = escapeLiteralWithCount(compiled, piece);
        outs[i] += encoded.text;
        escaped += encoded.escaped;
      } else {
        outs[i] += piece;
      }
    }
  }

  let changed = false;
  for (let i = 0; i < segments.length; i++) {
    if (outs[i] !== texts[i]) {
      segments[i].set(outs[i]);
      changed = true;
    }
  }
  return { changed, escaped };
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
  const structural: Region[] = [];

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
      if (region.escapable === false) structural.push(region);
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

  // Text that will NOT be escaped (allow / detect-only channels): a generated
  // placeholder appearing there stays a real ambiguity and is rejected. When
  // escaping is disabled, redact channels also count as unescaped (legacy).
  // Regions that opt out (`collisionScan: false`, e.g. reasoning) are skipped.
  const unescapedRegions = (
    config.escape
      ? regions.filter((r) => !collected.has(r))
      : regions.filter((r) => !r.detectOnly)
  ).filter((r) => r.collisionScan !== false);
  const protectedHaystack = [
    ...unescapedRegions.map((r) => regionText(r)),
    ...extraHaystack,
  ].join("\u0000");

  // Escaping is decided once per request: only when a trusted token exists is
  // there any ambiguity to remove, so PII-free requests stay byte-identical.
  const willHaveTokens = [...collected.values()].some((e) => e.detections.length > 0);
  const doEscape = config.escape && (session.entries().length > 0 || willHaveTokens);

  // Structural / opaque fields cannot be escaped: a shape literal there would
  // be indistinguishable from a trusted token, so reject explicitly (E4).
  if (doEscape) {
    for (const region of structural) {
      if (containsShape(config.template, regionText(region))) {
        guard(
          "privacy_field_unescapable",
          "A placeholder-shaped literal appears in a field that cannot be escaped",
          region.path,
        );
      }
    }
  }

  let redacted = 0;
  let escaped = 0;
  const allowTexts: string[] = [];
  const transformedExtensions = new Set<string>();

  // Phase 1: allocate placeholders in document order (deterministic numbering)
  // and collect replacements per region. Detection on raw text runs first, so
  // escaping never changes what the recognizer sees (SR-1).
  const replacements = new Map<Region, Replacement[]>();
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
      const mapping = session.getOrCreate(detection.type, original);
      if (protectedHaystack.includes(mapping.placeholder)) {
        guard(
          "privacy_placeholder_collision",
          "A generated placeholder collides with unescaped model-visible text",
          region.path,
        );
      }
      reps.push({ start: detection.start, end: detection.end, value: mapping.placeholder });
      redacted++;
      channels.add(region.channel);
    }
    replacements.set(region, reps);
  }

  // Phase 2: apply replacements and escape literal gaps.
  for (const region of regions) {
    const reps = replacements.get(region);
    if (!reps) continue;
    const result = transformSegments(region.segments, reps, config.template, doEscape);
    escaped += result.escaped;
    if (result.changed) {
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

  // Texts that opted out of placeholder scanning (reasoning). EgressVerify
  // skips foreign-shape checks for them but still checks leaked originals.
  const exemptTexts: string[] = [];
  for (const region of regions) {
    if (region.collisionScan === false) {
      for (const segment of region.segments) {
        const text = segment.get();
        if (text !== "") exemptTexts.push(text);
      }
    }
  }

  return {
    redacted,
    escaped,
    invalidDetections: state.invalid,
    degraded: state.degraded,
    channels,
    allowTexts: [...allowTexts, ...extraHaystack],
    exemptTexts,
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
