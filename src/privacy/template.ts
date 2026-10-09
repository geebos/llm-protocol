/**
 * Placeholder template compile / render / parse and HMAC tag (Appendix C).
 *
 * Templates are compiled once and must be unambiguous. The grammar is
 *   prefix {type} mid1 {N} [mid2 {tag}] suffix
 * and is parsed with suffix anchoring: the trailing literal (and tag) are
 * stripped first, then `N` is the trailing digit run, then `mid1` (whose last
 * character must not be a digit), then `{type}`. Dynamic tokens must be
 * separated by at least one literal character and the literal prefix must be
 * non-empty; adjacent dynamic tokens (e.g. `PII-{type}{N}`) are rejected
 * (PT-68).
 */
import { createHmac } from "node:crypto";

export const DEFAULT_TEMPLATE = "<private_placeholder_{type}_{N}>";
export const DEFAULT_TAG_BYTES = 12;
/** Frozen HMAC domain separation string (v1.6). */
export const TAG_DOMAIN = "llm-protocol-privacy-v1";

const TYPE_RE = /^[a-z0-9_]+$/;
const DIGIT_CHARS = /[0-9]/;
const HEX_CHARS = /[0-9a-fA-F]/;

/** Template literal characters that cannot appear (Appendix B rule 5). */
const FORBIDDEN_LITERAL = /["\\\u0000-\u001f\u007f]/;

export interface CompiledTemplate {
  raw: string;
  /** Literal before `{type}`. */
  prefix: string;
  /** Literal between `{type}` and `{N}`. */
  mid1: string;
  /** Literal between `{N}` and `{tag}` (empty when not in tagMode). */
  mid2: string;
  /** Literal after `{tag}` (or after `{N}` when not in tagMode). */
  suffix: string;
  tagMode: boolean;
  tagBytes: number;
  /** Whether the template contains only printable ASCII. */
  ascii: boolean;
}

export class TemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Compile and validate a placeholder template. Throws `TemplateError` when the
 * template is ambiguous or malformed.
 */
export function compileTemplate(
  raw: string,
  options: { tagMode?: boolean; tagBytes?: number } = {},
): CompiledTemplate {
  const tagMode = options.tagMode ?? false;
  const tagBytes = options.tagBytes ?? DEFAULT_TAG_BYTES;
  if (typeof raw !== "string" || raw === "") {
    throw new TemplateError("template_empty", "template must be a non-empty string");
  }
  if (FORBIDDEN_LITERAL.test(raw)) {
    throw new TemplateError(
      "template_forbidden_char",
      "template must not contain quotes, backslashes, control characters or newlines",
    );
  }
  if (!Number.isInteger(tagBytes) || tagBytes < DEFAULT_TAG_BYTES) {
    throw new TemplateError(
      "template_tag_bytes",
      "tagBytes must be an integer >= 12 (>=96-bit)",
    );
  }

  const typeCount = occurrences(raw, "{type}");
  const nCount = occurrences(raw, "{N}");
  const tagCount = occurrences(raw, "{tag}");
  if (typeCount !== 1) throw new TemplateError("template_type_count", "{type} must occur exactly once");
  if (nCount !== 1) throw new TemplateError("template_n_count", "{N} must occur exactly once");
  if (tagMode && tagCount !== 1) {
    throw new TemplateError("template_tag_count", "tagMode requires {tag} exactly once");
  }
  if (!tagMode && tagCount !== 0) {
    throw new TemplateError("template_unexpected_tag", "{tag} requires tagMode");
  }

  const idxType = raw.indexOf("{type}");
  const idxN = raw.indexOf("{N}");
  const idxTag = raw.indexOf("{tag}");
  if (idxType > idxN) {
    throw new TemplateError("template_token_order", "{type} must precede {N}");
  }
  if (tagMode && idxN > idxTag) {
    throw new TemplateError("template_token_order", "{N} must precede {tag}");
  }

  const prefix = raw.slice(0, idxType);
  const mid1 = raw.slice(idxType + "{type}".length, idxN);
  const mid2 = tagMode ? raw.slice(idxN + "{N}".length, idxTag) : "";
  const suffix = tagMode
    ? raw.slice(idxTag + "{tag}".length)
    : raw.slice(idxN + "{N}".length);

  const stripped = raw
    .replace("{type}", "")
    .replace("{N}", "")
    .replace("{tag}", "");
  if (stripped.includes("{") || stripped.includes("}")) {
    throw new TemplateError("template_token_unknown", "template contains an unknown token");
  }
  if (prefix === "") {
    throw new TemplateError("template_no_prefix", "template must start with a literal prefix");
  }
  if (mid1 === "" || DIGIT_CHARS.test(mid1[mid1.length - 1])) {
    throw new TemplateError(
      "template_ambiguous",
      "a literal separator not ending in a digit is required between {type} and {N}",
    );
  }
  if (tagMode && mid2 === "") {
    throw new TemplateError(
      "template_ambiguous",
      "a literal separator is required between {N} and the tag",
    );
  }

  return {
    raw,
    prefix,
    mid1,
    mid2,
    suffix,
    tagMode,
    tagBytes,
    ascii: /^[\x20-\x7e]*$/.test(raw),
  };
}

export function renderPlaceholder(
  compiled: CompiledTemplate,
  type: string,
  n: number,
  tag?: string,
): string {
  return (
    compiled.prefix +
    type +
    compiled.mid1 +
    String(n) +
    (compiled.tagMode ? compiled.mid2 + (tag ?? "") + compiled.suffix : compiled.suffix)
  );
}

export interface ParsedPlaceholder {
  type: string;
  n: number;
  tag?: string;
}

/**
 * Deterministically parse `text` against the compiled template. Returns
 * `undefined` when `text` is not a well-formed placeholder of this template.
 */
export function parsePlaceholder(
  compiled: CompiledTemplate,
  text: string,
): ParsedPlaceholder | undefined {
  if (!text.startsWith(compiled.prefix)) return undefined;
  let coreEnd = text.length;
  if (compiled.suffix !== "") {
    if (!text.endsWith(compiled.suffix)) return undefined;
    coreEnd -= compiled.suffix.length;
  }
  return parseCore(compiled, text.slice(compiled.prefix.length, coreEnd));
}

/** Parse `type + mid1 + N [+ mid2 + tag]` after prefix/suffix stripping. */
function parseCore(
  compiled: CompiledTemplate,
  core: string,
): ParsedPlaceholder | undefined {
  let tag: string | undefined;
  let rest = core;
  if (compiled.tagMode) {
    const tagLength = compiled.tagBytes * 2;
    if (rest.length < tagLength) return undefined;
    tag = rest.slice(rest.length - tagLength).toLowerCase();
    if (![...tag].every((c) => HEX_CHARS.test(c))) return undefined;
    rest = rest.slice(0, rest.length - tagLength);
    if (!rest.endsWith(compiled.mid2)) return undefined;
    rest = rest.slice(0, rest.length - compiled.mid2.length);
  }
  let digitStart = rest.length;
  while (digitStart > 0 && DIGIT_CHARS.test(rest[digitStart - 1])) digitStart--;
  if (digitStart === rest.length) return undefined;
  const digits = rest.slice(digitStart);
  if (digits.length > 1 && digits[0] === "0") return undefined;
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  const beforeN = rest.slice(0, digitStart);
  if (!beforeN.endsWith(compiled.mid1)) return undefined;
  const type = beforeN.slice(0, beforeN.length - compiled.mid1.length);
  if (!TYPE_RE.test(type)) return undefined;
  return tag === undefined ? { type, n } : { type, n, tag };
}

export function placeholderTag(
  key: Uint8Array,
  namespace: string,
  type: string,
  original: string,
  tagBytes: number,
): string {
  const hmac = createHmac("sha256", key);
  hmac.update(TAG_DOMAIN, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(namespace, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(type, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(original, "utf8");
  return hmac.digest("hex").slice(0, tagBytes * 2);
}

/** Reject type strings that cannot round-trip through the template grammar. */
export function isValidType(type: string, maxTypeLength: number): boolean {
  return TYPE_RE.test(type) && type.length <= maxTypeLength;
}

/**
 * Scan a template-shaped placeholder (registered or not) starting at `pos`.
 * Returns the end index (exclusive) of the `{type}...{N}` core (including tag
 * when tagMode), or `undefined`. Used by the unknown syntax scanner sharing
 * the registered matcher's safety boundary (PR-022).
 */
export function scanTemplateShape(
  compiled: CompiledTemplate,
  text: string,
  pos: number,
): number | undefined {
  if (!text.startsWith(compiled.prefix, pos)) return undefined;
  const bodyStart = pos + compiled.prefix.length;
  let best: number | undefined;
  let from = bodyStart;
  while (true) {
    const m = text.indexOf(compiled.mid1, from);
    if (m === -1) break;
    const type = text.slice(bodyStart, m);
    if (type !== "" && TYPE_RE.test(type)) {
      let cursor = m + compiled.mid1.length;
      const nStart = cursor;
      while (cursor < text.length && DIGIT_CHARS.test(text[cursor])) cursor++;
      if (cursor > nStart) {
        let coreEnd: number | undefined;
        if (compiled.tagMode) {
          if (text.startsWith(compiled.mid2, cursor)) {
            const tagStart = cursor + compiled.mid2.length;
            const tagLength = compiled.tagBytes * 2;
            const tag = text.slice(tagStart, tagStart + tagLength);
            if (tag.length === tagLength && [...tag].every((c) => HEX_CHARS.test(c))) {
              coreEnd = tagStart + tagLength;
            }
          }
        } else {
          coreEnd = cursor;
        }
        if (coreEnd !== undefined && (best === undefined || coreEnd > best)) {
          best = coreEnd;
        }
      }
    }
    from = m + 1;
  }
  if (best === undefined) return undefined;
  if (compiled.suffix && text.startsWith(compiled.suffix, best)) {
    return best + compiled.suffix.length;
  }
  return best;
}
