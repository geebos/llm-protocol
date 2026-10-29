/**
 * Placeholder shape: `{` + prefix + `-{type}-{tag}` + `}`.
 *
 * The braces are added automatically, so the caller supplies only the label
 * inside them. A token's identity is its `{tag}`: a short base32 digest of
 * `HMAC-SHA256(key, namespace, type, value)`. The same `(type, value)` yields
 * the same token inside one process, and a caller-supplied stable key makes it
 * stable across processes — so no counter is needed.
 *
 * The prefix is normalized: surrounding braces and trailing `-` / `_`
 * are trimmed, so `{private_placeholder_`, `private_placeholder-` and
 * `private_placeholder` all produce `{private_placeholder-{type}-{tag}}`.
 */
import { createHmac } from "node:crypto";

/** Default prefix content; tokens render as `{PP-{type}-{tag}}`. */
export const DEFAULT_PREFIX = "PP";
/** Fixed token braces (added automatically). */
const OPEN = "{";
const CLOSE = "}";
/** Default tag length in characters (base32, 5 chars = 25 bits). */
export const DEFAULT_TAG_LENGTH = 5;
/** Frozen HMAC domain separation string. */
export const TAG_DOMAIN = "llm-protocol-privacy-v1";
/** Literal between `{type}` and `{tag}`. */
const TYPE_TAG_SEPARATOR = "-";

const TYPE_RE = /^[a-z0-9_]+$/;
const TYPE_CHARS = /[a-z0-9_]/;
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

/** Prefix characters that cannot appear (quotes, backslash, control chars). */
const FORBIDDEN_PREFIX = /["\\\u0000-\u001f\u007f]/;

export interface CompiledTemplate {
  /** Normalized label inside the braces (no `{`/`}`, no trailing `-`/`_`). */
  prefix: string;
  /** Raw caller-supplied prefix, kept for round-tripping the config. */
  raw: string;
  /** Literal between `{type}` and `{tag}`; always `-`. */
  mid1: string;
  /** Length of the base32 tag in characters. */
  tagLength: number;
}

export class TemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

/**
 * Normalize a placeholder prefix: strip surrounding braces (they are added
 * automatically) and trim trailing `-` / `_` so the tail is always joined with
 * exactly one `-`.
 */
export function normalizePrefix(raw: string): string {
  let value = raw.trim();
  if (value.startsWith(OPEN)) value = value.slice(1);
  if (value.endsWith(CLOSE)) value = value.slice(0, -1);
  return value.replace(/[-_]+$/, "");
}

/**
 * Compile a placeholder prefix into the fixed shape `{prefix}-{type}-{tag}`.
 * Throws `TemplateError` when the prefix is empty or contains characters that
 * cannot appear in a placeholder (quotes, backslashes, control characters).
 */
export function compileTemplate(
  raw: string,
  options: { tagLength?: number } = {},
): CompiledTemplate {
  const tagLength = options.tagLength ?? DEFAULT_TAG_LENGTH;
  if (typeof raw !== "string" || raw === "") {
    throw new TemplateError("prefix_empty", "prefix must be a non-empty string");
  }
  if (FORBIDDEN_PREFIX.test(raw)) {
    throw new TemplateError(
      "prefix_forbidden_char",
      "prefix must not contain quotes, backslashes, control characters or newlines",
    );
  }
  if (!Number.isInteger(tagLength) || tagLength < MIN_TAG_LENGTH || tagLength > MAX_TAG_LENGTH) {
    throw new TemplateError(
      "template_tag_length",
      `tagLength must be an integer in [${MIN_TAG_LENGTH}, ${MAX_TAG_LENGTH}]`,
    );
  }
  const normalized = normalizePrefix(raw);
  if (normalized === "") {
    throw new TemplateError("prefix_empty", "prefix must not consist only of separators");
  }
  if (normalized.includes(OPEN) || normalized.includes(CLOSE)) {
    throw new TemplateError(
      "prefix_braces",
      "braces are added automatically and cannot appear inside the prefix",
    );
  }
  const prefix = normalized;
  return { prefix, raw, mid1: TYPE_TAG_SEPARATOR, tagLength };
}

export function renderPlaceholder(
  compiled: CompiledTemplate,
  type: string,
  tag: string,
): string {
  return `${OPEN}${compiled.prefix}-${type}${compiled.mid1}${tag}${CLOSE}`;
}

/** Literal head shared by every token of `type`. */
export function tokenHead(compiled: CompiledTemplate, type: string): string {
  return `${OPEN}${compiled.prefix}-${type}${compiled.mid1}`;
}

/** Literal head shared by every token of this shape. */
export function shapeHead(compiled: CompiledTemplate): string {
  return `${OPEN}${compiled.prefix}-`;
}

/** First character of every token (the opening brace). */
export function shapeStart(): string {
  return OPEN;
}

export interface ParsedPlaceholder {
  type: string;
  tag: string;
}

/**
 * Deterministically parse `text` against the compiled shape. Returns
 * `undefined` when `text` is not a well-formed token of this shape.
 */
export function parsePlaceholder(
  compiled: CompiledTemplate,
  text: string,
): ParsedPlaceholder | undefined {
  const { mid1, tagLength } = compiled;
  const head = shapeHead(compiled);
  if (!text.startsWith(head) || !text.endsWith(CLOSE)) return undefined;
  if (text.length < head.length + mid1.length + tagLength + CLOSE.length + 1) return undefined;
  const body = text.slice(0, -CLOSE.length);
  const tag = body.slice(body.length - tagLength);
  if (![...tag].every((c) => TAG_CHARS.test(c))) return undefined;
  const core = body.slice(head.length, body.length - tagLength);
  if (!core.endsWith(mid1)) return undefined;
  const type = core.slice(0, core.length - mid1.length);
  if (!TYPE_RE.test(type)) return undefined;
  return { type, tag };
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

/** Reject type strings that cannot round-trip through the shape. */
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
  const pre = shapeHead(compiled);
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
  // O(window); a backward walk rescaned the whole buffer on every call, which
  // made a per-character caller quadratic.
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
  // A tag shorter than the configured length still grows; a full-length tag may
  // still be followed by the closing brace, so it stays open too.
  const tag = afterType.slice(compiled.mid1.length);
  return (
    tag.length <= compiled.tagLength &&
    [...tag].every((c) => TAG_CHARS.test(c))
  );
}

/**
 * Scan a token-shaped text (registered or not) starting at `pos`. Returns the
 * end index (exclusive), or `undefined`. Used by the unknown syntax scanner
 * sharing the registered matcher's safety boundary (PR-022).
 */
export function scanTemplateShape(
  compiled: CompiledTemplate,
  text: string,
  pos: number,
): number | undefined {
  const pre = shapeHead(compiled);
  if (!text.startsWith(pre, pos)) return undefined;
  const bodyStart = pos + pre.length;
  // A valid `type` is a non-empty run of TYPE_CHARS, so no separator beyond the
  // first non-type character can yield a match. Bounding the run keeps the scan
  // linear instead of quadratic.
  const limit = Math.min(text.length, bodyStart + MAX_TYPE_SCAN);
  let typeEnd = bodyStart;
  while (typeEnd < limit && TYPE_CHARS.test(text[typeEnd])) typeEnd++;
  let best: number | undefined;
  let from = bodyStart + 1;
  while (from <= typeEnd) {
    const m = text.indexOf(compiled.mid1, from);
    if (m === -1 || m > typeEnd) break;
    const tagStart = m + compiled.mid1.length;
    const tag = text.slice(tagStart, tagStart + compiled.tagLength);
    if (tag.length === compiled.tagLength && [...tag].every((c) => TAG_CHARS.test(c))) {
      let end = tagStart + compiled.tagLength;
      // The closing brace is part of the shape when present.
      if (text.startsWith(CLOSE, end)) end += CLOSE.length;
      if (best === undefined || end > best) best = end;
    }
    from = m + 1;
  }
  return best;
}
