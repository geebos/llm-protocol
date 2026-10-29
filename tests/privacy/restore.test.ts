/**
 * Restore hold-point boundaries (shared FST, streaming and serial).
 *
 * Regression: the hold point (the buffer tail that may still grow into a token)
 * must never be used as a jump target, or a *complete* token sitting between the
 * cursor and that tail is emitted raw — restored serially, not while streaming.
 */
import { describe, expect, it } from "vitest";
import { compileTemplate, restoreString, tokenTag } from "../../src/index.js";

const BS = String.fromCharCode(92);
const compiled = compileTemplate("private_placeholder_");
const KEY = new Uint8Array(32).fill(11);
const TOKEN = `{private_placeholder-phone-${tokenTag(KEY, "", "phone", "13800138000", 5)}}`;
const entries = [{ placeholder: TOKEN, original: "13800138000" }];

function restore(text: string, escape = false): string {
  return restoreString(text, compiled, entries, 128, escape).text;
}

describe("restore hold-point boundaries", () => {
  it("restores a token that follows unregistered token-shaped text", () => {
    // A six-character tag run is not a token; the next complete token is.
    const bogus = TOKEN.slice(0, -1) + "a";
    expect(restore(`${bogus}${TOKEN}`)).toBe(`${bogus}13800138000`);
    expect(restore(`x ${bogus} ${TOKEN} y`)).toBe(`x ${bogus} 13800138000 y`);
  });

  it("restores a token followed by a partial prefix at the end", () => {
    expect(restore(`${TOKEN}{private_pl`)).toBe(`13800138000{private_pl`);
    expect(restore(`x${TOKEN}{private_placeholder-`)).toBe(
      `x13800138000{private_placeholder-`,
    );
  });

  it("does not split a legacy escape unit while skipping ahead", () => {
    expect(restore(`${TOKEN} and ${BS}${TOKEN}`, true)).toBe(
      `13800138000 and ${TOKEN}`,
    );
  });

  it("keeps a trailing partial token untouched", () => {
    const partial = TOKEN.slice(0, -2);
    expect(restore(`tail ${partial}`)).toBe(`tail ${partial}`);
  });
});
