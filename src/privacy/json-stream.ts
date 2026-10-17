/**
 * Incremental JSON-aware restore for streaming tool arguments (§8.2/§8.4).
 *
 * The document is walked by a small raw-JSON DFA that only tracks what
 * key/value classification needs: a container stack, the current string role
 * and the escape state. Everything outside string values is forwarded
 * byte-for-byte; string values are decoded, restored through `restoreText`
 * (Maximal Munch, bounded tail hold) and re-encoded as JSON string content.
 *
 * Safety properties:
 * - Keys are never restored (PT-37); a shape literal there only warns.
 * - Any structural surprise (invalid escape, control character, non-JSON
 *   literal, depth overrun, mismatched bracket) switches the block to `opaque`:
 *   no further restore and the remaining bytes pass through unchanged, so an
 *   ambiguity can never rewrite a key.
 * - The hold is bounded by `maxPlaceholderLength` because `restoreText` only
 *   withholds text from the earliest possible placeholder start, which can
 *   never lie further than that from the end (docs/06 §9.4).
 */
import { ESCAPE_CHAR, containsShape } from "./escape.js";
import { PrivacyGuardError } from "./errors.js";
import { restoreText } from "./restore.js";
import type { CompiledTemplate } from "./template.js";
import type { PlaceholderMatcher } from "./trie.js";
import type { PrivacyWarning } from "./types.js";

/** Maximum container nesting before the block is treated as opaque. */
const MAX_DEPTH = 32;
/** Extra key window kept beyond the placeholder length for shape detection. */
const KEY_TAIL_MARGIN = 64;
/** Literals longer than this are not validated (numbers can be long). */
const SCALAR_MAX = 64;

const QUOTE = '"';

export interface ToolRestoreStats {
  restored: number;
  unknown: number;
  overflowed: boolean;
  jsonParseFailures: number;
}

export interface ToolArgumentsRestoreOptions {
  compiled: CompiledTemplate;
  matcher: PlaceholderMatcher;
  maxPlaceholderLength: number;
  /** Decode legacy prefix escapes (docs/06 §7); off by default. */
  escape?: boolean;
  /** Cumulative upstream byte budget for one tool block. */
  maxBytes: number;
  overflowAction: "reject" | "flush_raw";
  stats: ToolRestoreStats;
  report: (warning: PrivacyWarning) => void;
}

export interface ToolArgumentsRestorer {
  /** Feed an upstream chunk and return the JSON text to emit right away. */
  feed(chunk: string): string[];
  /** Block finished: commit the held tail (needed before `tool_end`). */
  end(): string[];
  /** Cancellation/error: drop unconfirmed state without emitting it. */
  abort(): void;
  readonly degraded: boolean;
  readonly bytes: number;
}

type Mode = "json" | "opaque";
type Expect = "value" | "key" | "colon" | "comma_or_close";
type Role = "key" | "value";

interface EscapeDecoded {
  text: string;
  end: number;
}

type EscapeResult = EscapeDecoded | "need_more" | "invalid";

interface RunResult {
  decoded: string;
  /** Raw input span of the run (escape sequences included, quote excluded). */
  rawStart: number;
  rawEnd: number;
  next: number;
  closed: boolean;
  invalid: boolean;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Digits used by the literal validator. */
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Validate a literal token (number / true / false / null). Values are
 * forwarded byte-for-byte, so this only exists to notice payloads that are not
 * JSON at all; the response is always a warn-and-passthrough downgrade.
 */
function literalIsValid(token: string): boolean {
  if (token === "true" || token === "false" || token === "null") return true;
  let i = 0;
  if (token[i] === "-") i++;
  const whole = i;
  while (i < token.length && isDigit(token[i])) i++;
  if (i === whole) return false;
  if (token[i] === ".") {
    i++;
    const fraction = i;
    while (i < token.length && isDigit(token[i])) i++;
    if (i === fraction) return false;
  }
  if (token[i] === "e" || token[i] === "E") {
    i++;
    if (token[i] === "+" || token[i] === "-") i++;
    const exponent = i;
    while (i < token.length && isDigit(token[i])) i++;
    if (i === exponent) return false;
  }
  return i === token.length;
}

/**
 * Characters JSON.stringify escapes inside a string body: quote, backslash,
 * control characters and lone surrogates. Text with none of them is forwarded
 * untouched, which is both the common case for tool payloads and much cheaper
 * than a stringify + slice round trip.
 */
function needsEscape(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20) return true;
    if (code === 0x22 || code === 0x5c) return true;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

function isWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Decode one JSON escape sequence starting at `i` (which is a backslash). */
function decodeEscape(chunk: string, i: number): EscapeResult {
  const next = chunk[i + 1];
  if (next === undefined) return "need_more";
  switch (next) {
    case QUOTE:
      return { text: QUOTE, end: i + 2 };
    case ESCAPE_CHAR:
      return { text: ESCAPE_CHAR, end: i + 2 };
    case "/":
      return { text: "/", end: i + 2 };
    case "b":
      return { text: String.fromCharCode(8), end: i + 2 };
    case "f":
      return { text: String.fromCharCode(12), end: i + 2 };
    case "n":
      return { text: String.fromCharCode(10), end: i + 2 };
    case "r":
      return { text: String.fromCharCode(13), end: i + 2 };
    case "t":
      return { text: String.fromCharCode(9), end: i + 2 };
    case "u": {
      if (i + 6 > chunk.length) return "need_more";
      const hex = chunk.slice(i + 2, i + 6);
      if (!HEX4.test(hex)) return "invalid";
      return { text: String.fromCharCode(parseInt(hex, 16)), end: i + 6 };
    }
    default:
      return "invalid";
  }
}

/**
 * Hold a trailing lone high surrogate back: JSON would escape the two halves of
 * a surrogate pair separately, which is valid but makes the emitted bytes
 * depend on chunk boundaries. Keeping the pair together preserves raw text.
 */
function splitTrailingHighSurrogate(text: string): { out: string; carry: string } {
  if (!text) return { out: text, carry: "" };
  const code = text.charCodeAt(text.length - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    return { out: text.slice(0, -1), carry: text.slice(-1) };
  }
  return { out: text, carry: "" };
}

/** JSON string-body encoding: escapes quotes, backslashes, control chars. */
function jsonBody(text: string): string {
  return needsEscape(text) ? JSON.stringify(text).slice(1, -1) : text;
}

export function createToolArgumentsRestorer(
  options: ToolArgumentsRestoreOptions,
): ToolArgumentsRestorer {
  const { compiled, matcher, maxPlaceholderLength, maxBytes, overflowAction, stats, report } =
    options;
  const decodeEscapes = options.escape === true;
  const prefixHead = compiled.prefix[0];
  const keyTailLimit = maxPlaceholderLength + KEY_TAIL_MARGIN;
  const scalarChars = "0123456789+-.eEtrufalsn";

  let mode: Mode = "json";
  let stack: ("object" | "array")[] = [];
  let expect: Expect = "value";
  let inString = false;
  let role: Role = "value";
  /** Decoded tail of the current value string (bounded, see module header). */
  let decoded = "";
  /** Recent decoded key text, used for the PT-37 shape warning. */
  let keyTail = "";
  /** Raw chars held at a chunk boundary (incomplete escape / split surrogate). */
  let escapeBuf = "";
  /** Literal token (number / true / false / null) being forwarded raw. */
  let scalar = "";
  let scalarUnbounded = false;
  let bytes = 0;
  let parseFailureReported = false;
  let aborted = false;

  let fragments: string[] = [];
  let pendingRaw = "";

  // Plain function (not an inline comparison) so control-flow analysis does not
  // narrow `mode` to the value it was initialized with.
  const isOpaque = (): boolean => mode === "opaque";

  function flushRaw(): void {
    if (pendingRaw) {
      fragments.push(pendingRaw);
      pendingRaw = "";
    }
  }

  function emitRaw(text: string): void {
    pendingRaw += text;
  }

  function emitBody(text: string): void {
    if (!text) return;
    flushRaw();
    fragments.push(jsonBody(text));
  }

  function reportParseFailure(): void {
    if (parseFailureReported) return;
    parseFailureReported = true;
    stats.jsonParseFailures++;
    report({
      code: "privacy_json_parse_failed",
      message: "Tool arguments were not valid JSON; left unrestored",
    });
  }

  function degrade(): void {
    if (mode === "opaque") return;
    if (inString && role === "value") commitValue();
    inString = false;
    mode = "opaque";
    reportParseFailure();
  }

  /** Restore the held value tail and emit it in full (string/block end). */
  function commitValue(): void {
    if (!decoded) return;
    if (!decodeEscapes && decoded.indexOf(prefixHead) < 0) {
      emitBody(decoded);
      decoded = "";
      return;
    }
    if (decodeEscapes && decoded.indexOf(prefixHead) < 0 && decoded.indexOf(ESCAPE_CHAR) < 0) {
      emitBody(decoded);
      decoded = "";
      return;
    }
    const result = restoreText(decoded, matcher, compiled, {
      final: true,
      maxPlaceholderLength,
      escape: decodeEscapes,
    });
    stats.restored += result.matched;
    stats.unknown += result.unknown;
    for (const w of result.warnings) report(w);
    emitBody(result.out + result.rest);
    decoded = "";
  }

  /** Restore the held value tail, emitting only the confirmed prefix. */
  function drainValue(): void {
    if (!decoded) return;
    if (!decodeEscapes && decoded.indexOf(prefixHead) < 0) {
      const { out, carry } = splitTrailingHighSurrogate(decoded);
      emitBody(out);
      decoded = carry;
      return;
    }
    if (decodeEscapes && decoded.indexOf(prefixHead) < 0 && decoded.indexOf(ESCAPE_CHAR) < 0) {
      const { out, carry } = splitTrailingHighSurrogate(decoded);
      emitBody(out);
      decoded = carry;
      return;
    }
    const result = restoreText(decoded, matcher, compiled, {
      final: false,
      maxPlaceholderLength,
      escape: decodeEscapes,
    });
    stats.restored += result.matched;
    stats.unknown += result.unknown;
    for (const w of result.warnings) report(w);
    const { out, carry } = splitTrailingHighSurrogate(result.out);
    emitBody(out);
    decoded = carry + result.rest;
    // Defensive: `restoreText` never withholds more than the placeholder limit,
    // but a future template change must not turn this into unbounded memory.
    if (decoded.length > maxPlaceholderLength) commitValue();
  }

  function checkKeyShape(): void {
    if (keyTail && containsShape(compiled, keyTail)) {
      report({
        code: "privacy_json_key_placeholder",
        message: "A JSON key contains a placeholder shape and was not restored",
      });
    }
    keyTail = "";
  }

  /**
   * Scan one string body run: decode escapes, stop at a closing quote.
   *
   * Runs are sliced rather than concatenated per character: unescaped text is a
   * single `slice`, so a 512-byte chunk costs one scan plus one string.
   */
  function scanRun(chunk: string, start: number): RunResult {
    let decoded = "";
    let runStart = start;
    let i = start;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === QUOTE) {
        return {
          decoded: decoded + chunk.slice(runStart, i),
          rawStart: start,
          rawEnd: i,
          next: i + 1,
          closed: true,
          invalid: false,
        };
      }
      if (ch !== ESCAPE_CHAR) {
        if (ch.charCodeAt(0) < 0x20) {
          return {
            decoded: decoded + chunk.slice(runStart, i),
            rawStart: start,
            rawEnd: i,
            next: i,
            closed: false,
            invalid: true,
          };
        }
        i++;
        continue;
      }
      const esc = decodeEscape(chunk, i);
      if (esc === "need_more") {
        escapeBuf = chunk.slice(i);
        return {
          decoded: decoded + chunk.slice(runStart, i),
          rawStart: start,
          rawEnd: i,
          next: chunk.length,
          closed: false,
          invalid: false,
        };
      }
      if (esc === "invalid") {
        return {
          decoded: decoded + chunk.slice(runStart, i),
          rawStart: start,
          rawEnd: i,
          next: i,
          closed: false,
          invalid: true,
        };
      }
      decoded += chunk.slice(runStart, i) + esc.text;
      i = esc.end;
      runStart = i;
    }
    return {
      decoded: decoded + chunk.slice(runStart, i),
      rawStart: start,
      rawEnd: i,
      next: chunk.length,
      closed: false,
      invalid: false,
    };
  }

  function endScalar(): void {
    if (!(scalarUnbounded || literalIsValid(scalar))) {
      degrade();
      return;
    }
    scalar = "";
    scalarUnbounded = false;
    expect = "comma_or_close";
  }

  /** Handle one character outside a string. Returns the next index. */
  function structural(chunk: string, i: number): number {
    const ch = chunk[i];
    const top = stack[stack.length - 1];

    if (scalar !== "" || scalarUnbounded) {
      if (scalarChars.includes(ch)) {
        if (!scalarUnbounded) {
          scalar += ch;
          if (scalar.length > SCALAR_MAX) scalarUnbounded = true;
        }
        emitRaw(ch);
        return i + 1;
      }
      // Any other character terminates the literal; it is re-examined below.
      endScalar();
      return i;
    }

    if (ch === "{") {
      if (stack.length >= MAX_DEPTH) {
        degrade();
        return i;
      }
      stack.push("object");
      expect = "key";
      emitRaw(ch);
      return i + 1;
    }
    if (ch === "[") {
      if (stack.length >= MAX_DEPTH) {
        degrade();
        return i;
      }
      stack.push("array");
      expect = "value";
      emitRaw(ch);
      return i + 1;
    }
    if (ch === "}" || ch === "]") {
      const want = ch === "}" ? "object" : "array";
      if (top !== want) {
        degrade();
        return i;
      }
      stack.pop();
      expect = "comma_or_close";
      emitRaw(ch);
      return i + 1;
    }
    if (ch === ":") {
      if (top !== "object" || expect !== "colon") {
        degrade();
        return i;
      }
      expect = "value";
      emitRaw(ch);
      return i + 1;
    }
    if (ch === ",") {
      if (top === undefined) {
        degrade();
        return i;
      }
      expect = top === "object" ? "key" : "value";
      emitRaw(ch);
      return i + 1;
    }
    if (isWhitespace(ch)) {
      emitRaw(ch);
      return i + 1;
    }
    if (expect !== "value") {
      degrade();
      return i;
    }
    scalar = ch;
    emitRaw(ch);
    return i + 1;
  }

  function overflow(chunk: string): string[] {
    stats.overflowed = true;
    if (overflowAction === "reject") {
      throw new PrivacyGuardError(
        "privacy_buffer_overflow",
        "Privacy tool_arguments buffer exceeded its limit",
      );
    }
    report({
      code: "privacy_buffer_overflow",
      message: "Privacy tool_arguments buffer overflowed; remaining content flushed raw",
    });
    commitValue();
    inString = false;
    mode = "opaque";
    emitRaw(chunk);
    flushRaw();
    return fragments;
  }

  function finish(): string[] {
    flushRaw();
    const out = fragments;
    fragments = [];
    return out;
  }

  return {
    feed(chunk: string): string[] {
      if (aborted) return [];
      fragments = [];
      pendingRaw = "";
      bytes += chunk.length;
      if (mode === "opaque") {
        if (chunk) fragments.push(chunk);
        return finish();
      }
      let text = chunk;
      if (escapeBuf) {
        text = escapeBuf + chunk;
        escapeBuf = "";
      }
      if (bytes > maxBytes) return overflow(text);

      let i = 0;
      while (i < text.length) {
        if (isOpaque()) break;
        if (!inString) {
          if (text[i] === QUOTE) {
            inString = true;
            role =
              stack.length > 0 && stack[stack.length - 1] === "object" && expect === "key"
                ? "key"
                : "value";
            if (role === "key") keyTail = "";
            emitRaw(QUOTE);
            i++;
            continue;
          }
          i = structural(text, i);
          continue;
        }
        const run = scanRun(text, i);
        i = run.next;
        if (role === "value") {
          if (run.decoded) {
            decoded += run.decoded;
            drainValue();
          }
        } else {
          let rawEnd = run.rawEnd;
          if (!run.closed && rawEnd > run.rawStart) {
            // Keep a split surrogate pair together (see splitTrailingHighSurrogate).
            const code = text.charCodeAt(rawEnd - 1);
            if (code >= 0xd800 && code <= 0xdbff) {
              escapeBuf = text.slice(rawEnd - 1, rawEnd) + escapeBuf;
              rawEnd--;
            }
          }
          if (rawEnd > run.rawStart) emitRaw(text.slice(run.rawStart, rawEnd));
          if (run.decoded) keyTail = (keyTail + run.decoded).slice(-keyTailLimit);
        }
        if (run.invalid) {
          degrade();
          break;
        }
        if (run.closed) {
          if (role === "value") commitValue();
          else checkKeyShape();
          emitRaw(QUOTE);
          inString = false;
          // A key must be followed by `:`; a value by `,` / a closing bracket.
          expect = role === "key" ? "colon" : "comma_or_close";
        }
      }
      if (isOpaque() && i < text.length) {
        flushRaw();
        fragments.push(text.slice(i));
      }
      return finish();
    },

    end(): string[] {
      if (aborted) return [];
      fragments = [];
      pendingRaw = "";
      if (!isOpaque()) {
        if (scalar !== "" || scalarUnbounded) endScalar();
        if (inString && role === "value") commitValue();
        // A dangling escape sequence is part of the payload: keep the bytes.
        if (escapeBuf) {
          emitRaw(escapeBuf);
          escapeBuf = "";
        }
        if (inString) reportParseFailure();
        if (stack.length > 0) reportParseFailure();
      }
      escapeBuf = "";
      scalar = "";
      scalarUnbounded = false;
      return finish();
    },

    abort(): void {
      aborted = true;
      fragments = [];
      pendingRaw = "";
      decoded = "";
      keyTail = "";
      escapeBuf = "";
      scalar = "";
      scalarUnbounded = false;
    },

    get degraded(): boolean {
      return isOpaque();
    },

    get bytes(): number {
      return bytes;
    },
  };
}
