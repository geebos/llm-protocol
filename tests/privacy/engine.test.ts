/**
 * Privacy engine core domain tests (P1): template, session, redact/restore.
 * Covers PT-02/07/08/09/11/15/19/21/22/27/28/32/34/68.
 */
import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  createPrivacyEngine,
  parsePlaceholder,
  PrivacyGuardError,
  renderPlaceholder,
  scanTemplateShape,
  TemplateError,
  type PrivacyRecognizer,
} from "../../src/index.js";

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf("13800138000");
      while (idx !== -1) {
        out.push({ start: idx, end: idx + 11, type: "phone", value: "13800138000" });
        idx = text.indexOf("13800138000", idx + 1);
      }
      return out;
    },
  };
}

describe("placeholder prefix", () => {
  it("rejects an empty prefix", () => {
    expect(() => compileTemplate("")).toThrow(TemplateError);
    expect(() => compileTemplate("-_-")).toThrow(TemplateError);
  });

  it("rejects characters a placeholder cannot carry", () => {
    expect(() => compileTemplate('<p "x"_')).toThrow(TemplateError);
    const BS = String.fromCharCode(92);
    expect(() => compileTemplate(`<p${BS}x_`)).toThrow(TemplateError);
  });

  it("normalizes trailing separators", () => {
    for (const prefix of ["p_", "p-", "p_-_", "p", "<p_", "<p>"]) {
      const compiled = compileTemplate(prefix);
      expect(compiled.prefix).toBe("p");
      const text = renderPlaceholder(compiled, "phone", "abcde");
      // Brackets are added automatically.
      expect(text).toBe("<p-phone-abcde>");
      expect(parsePlaceholder(compiled, text)).toEqual({ type: "phone", tag: "abcde" });
    }
  });

  it("renders and parses a custom prefix (PT-21)", () => {
    const compiled = compileTemplate("[[");
    expect(compiled.prefix).toBe("[[");
    expect(renderPlaceholder(compiled, "phone", "abcde")).toBe("<[[-phone-abcde>");
    expect(parsePlaceholder(compiled, "<[[-phone-abcde>")).toEqual({
      type: "phone",
      tag: "abcde",
    });
  });

  it("scans a token shape (PT-27)", () => {
    const compiled = compileTemplate("<p_", { tagLength: 12 });
    const tag = "a".repeat(12);
    const text = `<p-phone-${tag}>`;
    expect(scanTemplateShape(compiled, text, 0)).toBe(text.length);
    expect(parsePlaceholder(compiled, text)).toEqual({ type: "phone", tag });
  });

  it("rejects tag lengths outside the supported range", () => {
    expect(() => compileTemplate("<p_", { tagLength: 2 })).toThrow(TemplateError);
    expect(() => compileTemplate("<p_", { tagLength: 128 })).toThrow(TemplateError);
  });

  it("does not accept a tag made of characters outside base32", () => {
    const compiled = compileTemplate("<p_");
    expect(parsePlaceholder(compiled, "<p-phone-01890")).toBeUndefined();
    expect(parsePlaceholder(compiled, "<p-phone-abc")).toBeUndefined();
    expect(parsePlaceholder(compiled, "<p-phone-abcde")).toBeUndefined();
  });
});

describe("privacy engine", () => {
  it("redacts and restores deterministically (PT-02/PT-15)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s1");
    const text = "call 13800138000 now";
    const redacted = await engine.redact(text, session, [phoneRecognizer()]);
    const token = session.entries()[0].placeholder;
    expect(token).toMatch(/^<PP-phone-[a-z2-7]{5}>$/);
    expect(redacted).toBe(`call ${token} now`);
    expect(engine.restore(redacted, session)).toBe(text);
    // idempotent: re-redacting already-mapped text is stable
    const again = await engine.redact(text, session, [phoneRecognizer()]);
    expect(again).toBe(redacted);
  });

  it("keeps the same mapping for repeated occurrences (PT-12/PT-20)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s2");
    const text = "13800138000 and 13800138000";
    const redacted = await engine.redact(text, session, [phoneRecognizer()]);
    const token = session.entries()[0].placeholder;
    expect(redacted).toBe(`${token} and ${token}`);
  });

  it("takes the outermost span (PT-08)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s3");
    const outer: PrivacyRecognizer = {
      priority: 1,
      recognize: () => [{ start: 0, end: 21, type: "outer" }],
    };
    const inner: PrivacyRecognizer = {
      priority: 2,
      recognize: () => [{ start: 5, end: 21, type: "inner" }],
    };
    const redacted = await engine.redact("mail user@example.com x", session, [outer, inner]);
    expect(redacted).toBe(`${session.entries()[0].placeholder} x`);
    expect(redacted).toContain("<PP-outer-");
  });

  it("rejects crossing spans", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s4");
    const a: PrivacyRecognizer = { priority: 1, recognize: () => [{ start: 0, end: 6, type: "a" }] };
    const b: PrivacyRecognizer = { priority: 2, recognize: () => [{ start: 3, end: 9, type: "b" }] };
    await expect(engine.redact("abcdefghij", session, [a, b])).rejects.toBeInstanceOf(
      PrivacyGuardError,
    );
  });

  it("rejects an invalid span that splits a surrogate pair (PT-09/PT-32)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s5");
    const bad: PrivacyRecognizer = { priority: 1, recognize: () => [{ start: 2, end: 3, type: "x" }] };
    await expect(engine.redact("a😀b", session, [bad])).rejects.toMatchObject({
      code: "privacy_invalid_detection",
    });
  });

  it("rejects a value mismatch (PT-09)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s6");
    const bad: PrivacyRecognizer = {
      priority: 1,
      recognize: () => [{ start: 0, end: 3, type: "x", value: "nope!" }],
    };
    await expect(engine.redact("abcdef", session, [bad])).rejects.toBeInstanceOf(
      PrivacyGuardError,
    );
  });

  it("rejects an over-long type (PT-19/PT-40)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s7");
    const bad: PrivacyRecognizer = {
      priority: 1,
      recognize: () => [{ start: 0, end: 3, type: "x".repeat(40) }],
    };
    await expect(engine.redact("abcdef", session, [bad])).rejects.toBeInstanceOf(
      PrivacyGuardError,
    );
  });

  it("leaves a placeholder-shaped literal untouched (PT-34)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s8");
    const literal = "<PP_phone_1>";
    const text = `13800138000 ${literal}`;
    const redacted = await engine.redact(text, session, [phoneRecognizer()]);
    // No escaping by default: only the detected value is replaced.
    expect(redacted).toBe(`${session.entries()[0].placeholder} ${literal}`);
    expect(engine.restore(redacted, session)).toBe(text);
  });

  it("restores a re-fed registered token instead of escaping it (PT-28)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s9");
    const token = await engine.redact("13800138000", session, [phoneRecognizer()]);
    const none: PrivacyRecognizer = { priority: 1, recognize: () => [] };
    const redacted = await engine.redact(token, session, [none]);
    // Provenance comes from the registry, so an issued token is trusted as-is.
    expect(redacted).toBe(token);
    expect(engine.restore(redacted, session)).toBe("13800138000");
  });

  it("does not restore unknown placeholders (PT-07)", () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s10");
    const text = "see <PP-phone-zzzzz";
    expect(engine.restore(text, session)).toBe(text);
  });

  it("rejects duplicate recognizer priorities (PT-22)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s11");
    const a: PrivacyRecognizer = { priority: 1, recognize: () => [] };
    const b: PrivacyRecognizer = { priority: 1, recognize: () => [] };
    await expect(engine.redact("x", session, [a, b])).rejects.toThrow();
  });

  it("isolates mappings between sessions (PT-11)", async () => {
    const engine = createPrivacyEngine();
    const one = engine.createSession("req-1");
    const two = engine.createSession("req-2");
    const redactedOne = await engine.redact("call 13800138000", one, [phoneRecognizer()]);
    const redactedTwo = await engine.redact("call 13800138000", two, [phoneRecognizer()]);
    expect(redactedOne).toBe(`call ${one.entries()[0].placeholder}`);
    expect(redactedTwo).toBe(`call ${two.entries()[0].placeholder}`);
    // The process tag key keeps tokens stable, so the same value yields the
    // same token; registries still never cross between sessions.
    expect(redactedOne).toBe(redactedTwo);
    expect(engine.getSession("req-1")).toBeDefined();
    engine.destroySession("req-1");
    expect(engine.getSession("req-1")).toBeUndefined();
    // The surviving session's mapping is unaffected.
    expect(engine.restore(redactedTwo, two)).toBe("call 13800138000");
  });
});
