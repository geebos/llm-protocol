/**
 * Restore engine (PR-019, §8, §9).
 *
 * Text restoration uses Maximal Munch over the registered placeholder trie and
 * a template-syntax scanner so a chunk ending in a possible placeholder
 * prefix is never emitted early (INV-2/INV-16/INV-17). Tool arguments are
 * restored JSON-aware, Value-only, so the result is always valid JSON
 * (INV-9/TR-003).
 */
import { createPlaceholderMatcher, type PlaceholderMatcher } from "./trie.js";
import { ESCAPE_CHAR, escapeStep } from "./escape.js";
import {
  parsePlaceholder,
  partialPlaceholderStart,
  scanTemplateShape,
  shapeHead,
  tokenHead,
  type CompiledTemplate,
} from "./template.js";
import type { PrivacyWarning } from "./types.js";

export interface RestoreTextOptions {
  final: boolean;
  maxPlaceholderLength: number;
  /** Decode legacy prefix escapes (docs/06 §7); off by default. */
  escape?: boolean;
}

export interface RestoreTextResult {
  out: string;
  /** Unconsumed tail that must be buffered for the next chunk. */
  rest: string;
  unknown: number;
  /** Number of registered placeholders restored in this pass. */
  matched: number;
  warnings: PrivacyWarning[];
}

/**
 * Restore placeholders in `buffer`. When `final` is false the tail may be
 * withheld (returned in `rest`) if it could still grow into a placeholder.
 */
export function restoreText(
  buffer: string,
  matcher: PlaceholderMatcher,
  compiled: CompiledTemplate,
  options: RestoreTextOptions,
): RestoreTextResult {
  let pos = 0;
  let out = "";
  let unknown = 0;
  let matched = 0;
  const warnings: PrivacyWarning[] = [];

  const holdTail = (from: number): RestoreTextResult => ({
    out,
    rest: buffer.slice(from),
    unknown,
    matched,
    warnings,
  });

  // The earliest index whose suffix could still grow into a placeholder is a
  // property of the buffer tail, not of `pos`. Compute it once and only
  // recompute after a match/escape has moved past it; rescanning it at every
  // position made restoration quadratic on large fields (INV-16/INV-17).
  let holdStart = partialPlaceholderStart(
    compiled,
    buffer,
    0,
    options.maxPlaceholderLength,
  );

  while (pos < buffer.length) {
    // Escaped literal (legacy opt-in): decode to the original character and
    // never let the decoded shape trigger a privacy restore (INV-E3/E7).
    const escape = options.escape === true ? escapeStep(compiled, buffer, pos) : undefined;
    if (escape) {
      if (escape.kind === "need_more") {
        if (!options.final) return holdTail(pos);
        out += ESCAPE_CHAR;
        pos++;
        continue;
      }
      out += escape.text;
      pos = escape.end;
      continue;
    }
    const result = matcher.matchAt(buffer, pos, options.final);
    if (result.kind === "match") {
      out += result.value;
      pos = result.end;
      matched++;
      continue;
    }
    if (result.kind === "need_more") {
      return holdTail(pos);
    }
    // Not a registered placeholder. External literal text that merely looks
    // like a token is ordinary text (it cannot restore anything), so it passes
    // through untouched. Only a shape of a type this session actually issued is
    // reported: that is a mangled token, i.e. the client would receive a raw
    // placeholder where the original value belonged.
    const shapeEnd = scanTemplateShape(compiled, buffer, pos);
    if (shapeEnd !== undefined) {
      const shapeText = buffer.slice(pos, shapeEnd);
      if (isKnownTypeToken(compiled, shapeText, matcher.knownTypes)) {
        unknown++;
        warnings.push({
          code: "privacy_unknown_placeholder",
          message: "A placeholder of a known type was left unrestored",
        });
      }
      out += buffer.slice(pos, shapeEnd);
      pos = shapeEnd;
      continue;
    }
    if (holdStart < pos) {
      holdStart = partialPlaceholderStart(
        compiled,
        buffer,
        pos,
        options.maxPlaceholderLength,
      );
    }
    // Nothing matches at `pos`. Emit forward, but stop before the next position
    // a token could start at or before `holdStart` (the tail that may still
    // grow into one). Jumping straight to `holdStart` would swallow a *complete*
    // token starting in between — `<token>a<token>` with a partial prefix at the
    // buffer end restored serially but not while streaming.
    const nextHead = buffer.indexOf(shapeHead(compiled), pos + 1);
    // A legacy escape unit must not be split: its backslash would be emitted
    // while the decoded shape still went through the matcher.
    const nextEscape =
      options.escape === true ? buffer.indexOf(ESCAPE_CHAR, pos + 1) : -1;
    const limit = Math.min(
      nextHead === -1 ? Number.POSITIVE_INFINITY : nextHead,
      nextEscape === -1 ? Number.POSITIVE_INFINITY : nextEscape,
      holdStart,
    );
    if (limit === Number.POSITIVE_INFINITY) {
      out += buffer.slice(pos);
      pos = buffer.length;
      continue;
    }
    if (limit > pos + 1) {
      out += buffer.slice(pos, limit);
      pos = limit;
      continue;
    }
    if (limit > pos) {
      out += buffer[pos];
      pos++;
      continue;
    }
    return holdTail(pos);
    pos++;
  }
  return { out, rest: "", unknown, matched, warnings };
}

/**
 * Whether a scanned shape starts with `prefix + knownType + mid1`. Used to
 * report tokens the model mangled (truncated, retagged) without flagging
 * unrelated literal text that merely looks like a placeholder.
 */
function isKnownTypeToken(
  compiled: CompiledTemplate,
  shapeText: string,
  knownTypes: Set<string>,
): boolean {
  for (const type of knownTypes) {
    if (shapeText.startsWith(tokenHead(compiled, type))) return true;
  }
  return false;
}

/** Restore placeholders in a plain string against a frozen session snapshot. */
export function restoreString(
  text: string,
  compiled: CompiledTemplate,
  entries: { placeholder: string; original: string }[],
  maxPlaceholderLength: number,
  escape = false,
): { text: string; unknown: number; matched: number; warnings: PrivacyWarning[] } {
  const matcher = createPlaceholderMatcher(compiled, entries);
  const result = restoreText(text, matcher, compiled, {
    final: true,
    maxPlaceholderLength,
    escape,
  });
  return {
    text: result.out + result.rest,
    unknown: result.unknown,
    matched: result.matched,
    warnings: result.warnings,
  };
}

export interface JsonRestoreResult {
  text: string;
  unknown: number;
  matched: number;
  warnings: PrivacyWarning[];
  parseFailed: boolean;
}

/**
 * JSON-aware Value-only restore. Object keys are never modified; a placeholder
 * appearing in a key produces a warning instead (PT-37).
 */
export function restoreJsonText(
  text: string,
  compiled: CompiledTemplate,
  entries: { placeholder: string; original: string }[],
  maxPlaceholderLength: number,
  escape = false,
): JsonRestoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, unknown: 0, matched: 0, warnings: [], parseFailed: true };
  }
  const matcher = createPlaceholderMatcher(compiled, entries);
  let unknown = 0;
  let matched = 0;
  const warnings: PrivacyWarning[] = [];

  const restoreValue = (value: string): string => {
    const r = restoreText(value, matcher, compiled, {
      final: true,
      maxPlaceholderLength,
      escape,
    });
    unknown += r.unknown;
    matched += r.matched;
    warnings.push(...r.warnings);
    return r.out + r.rest;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return restoreValue(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (keyLooksLikePlaceholder(key, compiled)) {
          warnings.push({
            code: "privacy_json_key_placeholder",
            message: "A JSON key contains a placeholder shape and was not restored",
          });
        }
        out[key] = walk(item);
      }
      return out;
    }
    return value;
  };

  return {
    text: JSON.stringify(walk(parsed)),
    unknown,
    matched,
    warnings,
    parseFailed: false,
  };
}

function keyLooksLikePlaceholder(key: string, compiled: CompiledTemplate): boolean {
  if (!key.includes(compiled.prefix)) return false;
  const idx = key.indexOf(compiled.prefix);
  return scanTemplateShape(compiled, key, idx) !== undefined;
}

export { createPlaceholderMatcher, parsePlaceholder };
