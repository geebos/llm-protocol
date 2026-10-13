/**
 * Provenance-aware reversible escaping (docs/06 §7).
 *
 * External text (file content, user input, tool results) may contain strings
 * that are shape-identical to a privacy placeholder. Instead of failing closed
 * both ways (collision / unknown-shape), literal text is prefix-escaped so it
 * can never be confused with an engine-generated trusted token:
 *
 *   E(x): `\` -> `\\`; each template shape -> `\` + shape
 *   D(y): `\\` -> `\`;  `\<prefix[0]>` -> `<prefix[0]>` (single pass)
 *
 * The template forbids `\` in literals, so generated placeholders never contain
 * the escape character (INV-E2). Decoding is non-recursive and never feeds its
 * output back into matching (INV-E3).
 */
import { scanTemplateShape, type CompiledTemplate } from "./template.js";

export const ESCAPE_CHAR = "\\";

/**
 * Encode literal text so that no template shape survives unescaped. A shape is
 * prefix-escaped with a single backslash; every backslash is doubled so the
 * transform stays reversible (`D(E(x)) = x`, INV-E1).
 */
export function escapeLiteral(compiled: CompiledTemplate, text: string): string {
  return escapeLiteralWithCount(compiled, text).text;
}

/** `escapeLiteral` plus the number of shapes that were prefix-escaped. */
export function escapeLiteralWithCount(
  compiled: CompiledTemplate,
  text: string,
): { text: string; escaped: number } {
  let out = "";
  let escaped = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ESCAPE_CHAR) {
      out += ESCAPE_CHAR + ESCAPE_CHAR;
      i++;
      continue;
    }
    if (ch === compiled.prefix[0]) {
      const end = scanTemplateShape(compiled, text, i);
      if (end !== undefined) {
        out += ESCAPE_CHAR + text.slice(i, end);
        escaped++;
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, escaped };
}

export type EscapeStep =
  | { kind: "emit"; text: string; end: number }
  | { kind: "need_more" };

/** Whether `text` contains at least one template-shaped literal. */
export function containsShape(compiled: CompiledTemplate, text: string): boolean {
  let i = text.indexOf(compiled.prefix[0]);
  while (i !== -1) {
    if (scanTemplateShape(compiled, text, i) !== undefined) return true;
    i = text.indexOf(compiled.prefix[0], i + 1);
  }
  return false;
}

/**
 * Consume one escape unit at `pos`. Returns `undefined` when `pos` does not
 * start with the escape character. `need_more` means the buffer ends in a bare
 * escape character, which may still become `\\` or `\<prefix[0]>` (INV-E6).
 */
export function escapeStep(
  compiled: CompiledTemplate,
  buffer: string,
  pos: number,
): EscapeStep | undefined {
  if (buffer[pos] !== ESCAPE_CHAR) return undefined;
  const next = buffer[pos + 1];
  if (next === undefined) return { kind: "need_more" };
  if (next === ESCAPE_CHAR) return { kind: "emit", text: ESCAPE_CHAR, end: pos + 2 };
  if (next === compiled.prefix[0]) {
    return { kind: "emit", text: compiled.prefix[0], end: pos + 2 };
  }
  return { kind: "emit", text: ESCAPE_CHAR, end: pos + 1 };
}
