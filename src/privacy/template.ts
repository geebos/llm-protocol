/**
 * Placeholder template compile / render / parse and token tag.
 *
 * A token's identity is its `{tag}`: a short base32 digest of
 * `HMAC-SHA256(key, namespace, type, value)`. The same `(type, value)` yields
 * the same token inside one session, and a caller-supplied stable key makes it
 * stable across requests — so no counter (`{N}`) is needed.
 *
 * Grammar:
 *   prefix {type} mid1 [ {N} mid2 ] {tag} suffix   (tag mode, default)
 *   prefix {type} mid1 {N} suffix                  (legacy numbered mode)
 *
 * The grammar must stay unambiguous. In tag mode `{tag}` is required and is
 * parsed by stripping the fixed-length trailing tag run first; in legacy mode
 * `{N}` is required and is parsed by anchoring on the trailing digit run, which
 * is why `mid1` may not end with a digit there.
 */
import { createHmac } from "node:crypto";

/** Default template (tag mode): identity comes from the tag, not a counter. */
export const DEFAULT_TEMPLATE = "<private_placeholder_{type}-{tag}>";
/** Legacy numbered template; used only when `tagMode` is disabled. */
export const LEGACY_TEMPLATE = "<private_placeholder_{type}_{N}>";
/** Default tag length in characters (base32, 5 chars = 25 bits). */
export const DEFAULT_TAG_LENGTH = 5;
/** Frozen HMAC domain separation string. */
export const TAG_DOMAIN = "llm-protocol-privacy-v1";

const TYPE_RE = /^[a-z0-9_]+$/;
const TYPE_CHARS = /[a-z0-9_]/;
const DIGIT_CHARS = /[0-9]/;
/** Tag alphabet: RFC 4648 base32, lowercase, no padding. */
const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TAG_CHARS = /[a-z2-7]/;
/**
 * Upper bound on the literal `type` run considered by `scanTemplateShape`.
 * Real types are `<= maxTypeLength` (default 32); the cap keeps a buffer full
 * of prefixes from triggering quadratic scanning on adversarial input.
 */
const MAX_TYPE_SCAN = 128;
const MIN_TAG_LENGTH = 4;
const MAX_TAG_LENGTH = 64;

/** Template literal characters that cannot appear (Appendix B rule 5). */
const FORBIDDEN_LITERAL = /["\\\u0000-\u001f\u007f]/;

export interface CompiledTemplate {
  raw: string;
  /** Literal before `{type}`. */
  prefix: string;
  /** Literal between `{type}` and `{N}`/`{tag}`. */
  mid1: string;
  /** Literal between `{N}` and `{tag}` (empty unless both are present). */
  mid2: string;
  /** Literal after the last dynamic token. */
  suffix: string;
  /** Tag mode: the token carries an HMAC tag (default). */
  tagMode: boolean;
  /** Whether the template carries a legacy `{N}` counter. */
  hasN: boolean;
  /** Tag length in characters (0 when not in tag mode). */
  tagLength: number;
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
  options: { tagMode?: boolean; tagLength?: number } = {},
): CompiledTemplate {
  const tagMode = options.tagMode ?? true;
  const tagLength = options.tagLength ?? DEFAULT_TAG_LENGTH;
  if (typeof raw !== "string" || raw === "") {
    throw new TemplateError("template_empty", "template must be a non-empty string");
  }
  if (FORBIDDEN_LITERAL.test(raw)) {
    throw new TemplateError(
      "template_forbidden_char",
      "template must not contain quotes, backslashes, control characters or newlines",
    );
  }
  if (
    tagMode &&
    (!Number.isInteger(tagLength) || tagLength < MIN_TAG_LENGTH || tagLength > MAX_TAG_LENGTH)
  ) {
    throw new TemplateError(
      "template_tag_length",
      `tagLength must be an integer in [${MIN_TAG_LENGTH}, ${MAX_TAG_LENGTH}]`,
    );
  }

  const typeCount = occurrences(raw, "{type}");
  const nCount = occurrences(raw, "{N}");
  const tagCount = occurrences(raw, "{tag}");
  if (typeCount !== 1) {
    throw new TemplateError("template_type_count", "{type} must occur exactly once");
  }
  if (nCount > 1) {
    throw new TemplateError("template_n_count", "{N} must occur at most once");
  }
  if (tagMode && tagCount !== 1) {
    throw new TemplateError("template_tag_count", "tagMode requires {tag} exactly once");
  }
  if (!tagMode) {
    if (tagCount !== 0) {
      throw new TemplateError("template_unexpected_tag", "{tag} requires tagMode");
    }
    if (nCount !== 1) {
      throw new TemplateError("template_n_count", "numbered mode requires {N} exactly once");
    }
  }

  const idxType = raw.indexOf("{type}");
  const idxN = raw.indexOf("{N}");
  const idxTag = raw.indexOf("{tag}");
  const hasN = nCount === 1;
  if (hasN && idxType > idxN) {
    throw new TemplateError("template_token_order", "{type} must precede {N}");
  }
  if (tagMode && hasN && idxN > idxTag) {
    throw new TemplateError("template_token_order", "{N} must precede {tag}");
  }

  const prefix = raw.slice(0, idxType);
  const afterType = idxType + "{type}".length;
  const mid1 = hasN
    ? raw.slice(afterType, idxN)
    : tagMode
      ? raw.slice(afterType, idxTag)
      : raw.slice(afterType);
  const mid2 = hasN && tagMode ? raw.slice(idxN + "{N}".length, idxTag) : "";
  const suffix = tagMode
    ? raw.slice(idxTag + "{tag}".length)
    : hasN
      ? raw.slice(idxN + "{N}".length)
      : raw.slice(afterType + mid1.length);

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
  if (mid1 === "") {
    throw new TemplateError(
      "template_ambiguous",
      "a literal separator is required between {type} and the next token",
    );
  }
  if (hasN && DIGIT_CHARS.test(mid1[mid1.length - 1])) {
    throw new TemplateError(
      "template_ambiguous",
      "a literal separator not ending in a digit is required between {type} and {N}",
    );
  }
  if (hasN && tagMode && mid2 === "") {
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
    hasN,
    tagLength: tagMode ? tagLength : 0,
    ascii: /^[\x20-\x7e]*$/.test(raw),
  };
}

export function renderPlaceholder(
  compiled: CompiledTemplate,
  type: string,
  n?: number,
  tag?: string,
): string {
  if (!compiled.hasN) {
    return compiled.prefix + type + compiled.mid1 + (tag ?? "") + compiled.suffix;
  }
  const core = type + compiled.mid1 + (n === undefined ? "" : String(n));
  if (!compiled.tagMode) return compiled.prefix + core + compiled.suffix;
  return compiled.prefix + core + compiled.mid2 + (tag ?? "") + compiled.suffix;
}

export interface ParsedPlaceholder {
  type: string;
  n?: number;
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
  if (coreEnd < compiled.prefix.length) return undefined;
  return parseCore(compiled, text.slice(compiled.prefix.length, coreEnd));
}

/** Parse `type + mid1 + N + mid2 + tag` after prefix/suffix stripping. */
function parseCore(
  compiled: CompiledTemplate,
  core: string,
): ParsedPlaceholder | undefined {
  let rest = core;
  let tag: string | undefined;
  if (compiled.tagMode) {
    const tagLength = compiled.tagLength;
    if (rest.length < tagLength) return undefined;
    tag = rest.slice(rest.length - tagLength);
    if (![...tag].every((c) => TAG_CHARS.test(c))) return undefined;
    rest = rest.slice(0, rest.length - tagLength);
    if (compiled.hasN) {
      if (rest.length < compiled.mid2.length) return undefined;
      if (!rest.endsWith(compiled.mid2)) return undefined;
      rest = rest.slice(0, rest.length - compiled.mid2.length);
    }
  }
  if (!compiled.hasN) {
    if (!rest.endsWith(compiled.mid1)) return undefined;
    const type = rest.slice(0, rest.length - compiled.mid1.length);
    if (!TYPE_RE.test(type)) return undefined;
    return { type, tag };
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

/**
 * Token tag: the first `tagLength` base32 characters of
 * `HMAC-SHA256(K, domain || 0x00 || namespace || type || value [|| salt])`.
 *
 * `salt` only advances when two distinct values of the same type collide on the
 * truncated digest, so allocation stays deterministic within a session.
 */
export function tokenTag(
  key: Uint8Array,
  namespace: string,
  type: string,
  original: string,
  tagLength: number,
  salt = 0,
): string {
  const hmac = createHmac("sha256", key);
  hmac.update(TAG_DOMAIN, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(namespace, "utf8");
  updateLengthPrefixed(hmac, type);
  updateLengthPrefixed(hmac, original);
  if (salt > 0) updateLengthPrefixed(hmac, String(salt));
  return base32(hmac.digest(), tagLength);
}

/** Length-prefixed update so the HMAC domain is unambiguous. */
function updateLengthPrefixed(
  hmac: ReturnType<typeof createHmac>,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  hmac.update(length);
  hmac.update(bytes);
}

/** First `length` base32 (RFC 4648, lowercase, unpadded) characters. */
function base32(digest: Uint8Array, length: number): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of digest) {
    acc = ((acc << 8) | byte) & 0xfffff;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += TAG_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

/** Reject type strings that cannot round-trip through the template grammar. */
export function isValidType(type: string, maxTypeLength: number): boolean {
  return TYPE_RE.test(type) && type.length <= maxTypeLength;
}

/**
 * Earliest index at which `text` ends with a partial placeholder (a proper
 * prefix of the literal, or the full literal followed by a partial core).
 * Returns `text.length` when the tail is not a possible placeholder start.
 * Used as the shared unknown-syntax safety boundary (INV-17).
 */
export function partialPlaceholderStart(
  compiled: CompiledTemplate,
  text: string,
  from: number,
  maxPlaceholderLength: number,
): number {
  const pre = compiled.prefix;
  let best = text.length;
  const max = Math.min(pre.length - 1, text.length - from);
  for (let len = max; len >= 1; len--) {
    if (text.endsWith(pre.slice(0, len))) {
      best = text.length - len;
      break;
    }
  }
  // A placeholder start can never lie further than `maxPlaceholderLength` from
  // the end, so scan only that tail window. Forward `indexOf` keeps this
  // O(window); the previous `lastIndexOf` walk rescaned the whole buffer on
  // every call, which made a per-character caller quadratic.
  const windowStart = Math.max(from, text.length - maxPlaceholderLength);
  let idx = text.indexOf(pre, windowStart);
  while (idx !== -1) {
    if (isPartialCore(compiled, text.slice(idx + pre.length)) && idx < best) {
      best = idx;
    }
    idx = text.indexOf(pre, idx + 1);
  }
  return best;
}

function isPartialCore(compiled: CompiledTemplate, rest: string): boolean {
  if (rest === "") return true;
  let i = 0;
  while (i < rest.length && TYPE_CHARS.test(rest[i])) i++;
  if (i === rest.length) return true;
  const afterType = rest.slice(i);
  if (compiled.mid1.startsWith(afterType)) return true;
  if (!afterType.startsWith(compiled.mid1)) return false;
  const afterMid1 = afterType.slice(compiled.mid1.length);
  if (afterMid1 === "") return true;
  if (!compiled.hasN) {
    return (
      afterMid1.length <= compiled.tagLength &&
      [...afterMid1].every((c) => TAG_CHARS.test(c))
    );
  }
  let j = 0;
  while (j < afterMid1.length && DIGIT_CHARS.test(afterMid1[j])) j++;
  if (j === afterMid1.length) return true;
  if (!compiled.tagMode) return false;
  const afterN = afterMid1.slice(j);
  if (compiled.mid2.startsWith(afterN)) return true;
  if (!afterN.startsWith(compiled.mid2)) return false;
  const tag = afterN.slice(compiled.mid2.length);
  return tag.length <= compiled.tagLength && [...tag].every((c) => TAG_CHARS.test(c));
}

/**
 * Scan a template-shaped placeholder (registered or not) starting at `pos`.
 * Returns the end index (exclusive) of the core (including tag when tag mode),
 * or `undefined`. Used by the unknown syntax scanner sharing the registered
 * matcher's safety boundary (PR-022).
 */
export function scanTemplateShape(
  compiled: CompiledTemplate,
  text: string,
  pos: number,
): number | undefined {
  if (!text.startsWith(compiled.prefix, pos)) return undefined;
  const bodyStart = pos + compiled.prefix.length;
  let best: number | undefined;
  // A valid `type` is a non-empty run of TYPE_CHARS, so no `mid1` beyond the
  // first non-type character can yield a match. Bounding the run keeps the
  // scan linear instead of quadratic (the `type` substring is therefore always
  // a valid, non-empty TYPE_CHARS run and needs no re-validation).
  const limit = Math.min(text.length, bodyStart + MAX_TYPE_SCAN);
  let typeEnd = bodyStart;
  while (typeEnd < limit && TYPE_CHARS.test(text[typeEnd])) typeEnd++;
  let from = bodyStart + 1;
  while (from <= typeEnd) {
    const m = text.indexOf(compiled.mid1, from);
    if (m === -1 || m > typeEnd) break;
    const cursor = m + compiled.mid1.length;
    let coreEnd: number | undefined;
    if (!compiled.hasN) {
      const tag = text.slice(cursor, cursor + compiled.tagLength);
      if (tag.length === compiled.tagLength && [...tag].every((c) => TAG_CHARS.test(c))) {
        coreEnd = cursor + compiled.tagLength;
      }
    } else {
      let nEnd = cursor;
      while (nEnd < text.length && DIGIT_CHARS.test(text[nEnd])) nEnd++;
      if (nEnd > cursor) {
        if (compiled.tagMode) {
          if (text.startsWith(compiled.mid2, nEnd)) {
            const tagStart = nEnd + compiled.mid2.length;
            const tag = text.slice(tagStart, tagStart + compiled.tagLength);
            if (
              tag.length === compiled.tagLength &&
              [...tag].every((c) => TAG_CHARS.test(c))
            ) {
              coreEnd = tagStart + compiled.tagLength;
            }
          }
        } else {
          coreEnd = nEnd;
        }
      }
    }
    if (coreEnd !== undefined && (best === undefined || coreEnd > best)) {
      best = coreEnd;
    }
    from = m + 1;
  }
  if (best === undefined) return undefined;
  if (compiled.suffix && text.startsWith(compiled.suffix, best)) {
    return best + compiled.suffix.length;
  }
  return best;
}
