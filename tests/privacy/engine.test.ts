/**
 * Privacy engine core domain tests (P1): template, session, redact/restore.
 * Covers PT-02/07/08/09/15/19/21/22/27/28/32/34/68.
 */
import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  createPrivacyEngine,
  parsePlaceholder,
  PrivacyGuardError,
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

describe("privacy template", () => {
  it("rejects adjacent dynamic tokens (PT-68)", () => {
    expect(() => compileTemplate("PII-{type}{N}")).toThrow(TemplateError);
  });

  it("rejects a missing literal prefix (PT-21)", () => {
    expect(() => compileTemplate("{type}-{N}")).toThrow(TemplateError);
  });

  it("renders and parses a custom template (PT-21)", () => {
    const compiled = compileTemplate("[[{type}:{N}]]");
    expect(compiled.prefix).toBe("[[");
    expect(parsePlaceholder(compiled, "[[phone:3]]")).toEqual({ type: "phone", n: 3 });
    expect(parsePlaceholder(compiled, "[[phone:0]]")).toBeUndefined();
  });

  it("scans a template shape with tagMode (PT-27)", () => {
    const compiled = compileTemplate("<p_{type}_{N}_{tag}>", { tagMode: true, tagBytes: 12 });
    const tag = "a".repeat(24);
    const text = `<p_phone_1_${tag}>`;
    expect(scanTemplateShape(compiled, text, 0)).toBe(text.length);
    expect(parsePlaceholder(compiled, text)).toEqual({ type: "phone", n: 1, tag });
  });
});

describe("privacy engine", () => {
  it("redacts and restores deterministically (PT-02/PT-15)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s1");
    const text = "call 13800138000 now";
    const redacted = await engine.redact(text, session, [phoneRecognizer()]);
    expect(redacted).toBe("call <private_placeholder_phone_1> now");
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
    expect(redacted).toBe(
      "<private_placeholder_phone_1> and <private_placeholder_phone_1>",
    );
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
    expect(redacted).toBe("<private_placeholder_outer_1> x");
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

  it("rejects a placeholder collision with source text (PT-34)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s8");
    const text = "13800138000 <private_placeholder_phone_1>";
    await expect(engine.redact(text, session, [phoneRecognizer()])).rejects.toMatchObject({
      code: "privacy_placeholder_collision",
    });
  });

  it("leaves an already-registered placeholder literal untouched (PT-28)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s9");
    // Register phone_1 first, then feed the placeholder literal back in.
    await engine.redact("13800138000", session, [phoneRecognizer()]);
    const literal = "<private_placeholder_phone_1>";
    const recognizer: PrivacyRecognizer = {
      priority: 1,
      recognize: () => [{ start: 0, end: literal.length, type: "phone" }],
    };
    const redacted = await engine.redact(literal, session, [recognizer]);
    expect(redacted).toBe(literal);
  });

  it("does not restore unknown placeholders (PT-07)", () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("s10");
    const text = "see <private_placeholder_phone_9>";
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
    expect(redactedOne).toBe("call <private_placeholder_phone_1>");
    expect(redactedTwo).toBe("call <private_placeholder_phone_1>");
    expect(engine.getSession("req-1")).toBeDefined();
    engine.destroySession("req-1");
    expect(engine.getSession("req-1")).toBeUndefined();
    // The surviving session's mapping is unaffected.
    expect(engine.restore(redactedTwo, two)).toBe("call 13800138000");
  });
});
