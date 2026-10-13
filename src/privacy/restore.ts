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
  type CompiledTemplate,
} from "./template.js";
import type { PrivacyWarning } from "./types.js";

export interface RestoreTextOptions {
  final: boolean;
  maxPlaceholderLength: number;
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
    // Escaped literal: decode to the original character and never let the
    // decoded shape trigger a privacy restore (INV-E3/E7).
    const escape = escapeStep(compiled, buffer, pos);
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
    // Not a registered placeholder: check the shared unknown-syntax boundary.
    const shapeEnd = scanTemplateShape(compiled, buffer, pos);
    if (shapeEnd !== undefined) {
      unknown++;
      warnings.push({
        code: "privacy_unknown_placeholder",
        message: "An unknown placeholder shape was left unrestored",
      });
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
    if (holdStart < buffer.length) {
      out += buffer.slice(pos, holdStart);
      return holdTail(holdStart);
    }
    out += buffer[pos];
    pos++;
  }
  return { out, rest: "", unknown, matched, warnings };
}

/** Restore placeholders in a plain string against a frozen session snapshot. */
export function restoreString(
  text: string,
  compiled: CompiledTemplate,
  entries: { placeholder: string; original: string }[],
  maxPlaceholderLength: number,
): { text: string; unknown: number; matched: number; warnings: PrivacyWarning[] } {
  const matcher = createPlaceholderMatcher(compiled, entries);
  const result = restoreText(text, matcher, compiled, {
    final: true,
    maxPlaceholderLength,
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
