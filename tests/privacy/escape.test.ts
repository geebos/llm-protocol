/**
 * Legacy provenance escaping (docs/06 §7) — opt-in.
 *
 * Escaping is no longer the default: literal text is never rewritten unless
 * `mapping.escape: true` is requested. These tests pin the legacy contract
 * (`D(E(x)) = x`, single pass, non-recursive) and the default byte-identity
 * guarantee (INV-A1).
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyCompletionReport, PrivacyRecognizer } from "../../src/index.js";
import { compileTemplate, tokenTag } from "../../src/privacy/template.js";
import { escapeLiteral, escapeStep } from "../../src/privacy/escape.js";
import { restoreJsonText, restoreText } from "../../src/privacy/restore.js";
import { createPlaceholderMatcher } from "../../src/privacy/trie.js";

const BS = String.fromCharCode(92);
const compiled = compileTemplate("private_placeholder_");
const KEY = new Uint8Array(32).fill(3);
const SHAPE = `{private_placeholder-phone-${tokenTag(KEY, "", "phone", "13800138000", 5)}}`;

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf("13800138000");
      while (idx !== -1) {
        out.push({ start: idx, end: idx + 11, type: "phone" });
        idx = text.indexOf("13800138000", idx + 1);
      }
      return out;
    },
  };
}

const entries = [{ placeholder: SHAPE, original: "13800138000" }];

function restoreAll(text: string, escape = true): string {
  const result = restoreText(text, createPlaceholderMatcher(compiled, entries), compiled, {
    final: true,
    maxPlaceholderLength: 128,
    escape,
  });
  return result.out + result.rest;
}

/** Feed chunk by chunk through the shared streaming decoder. */
function restoreChunked(chunks: string[]): string {
  const matcher = createPlaceholderMatcher(compiled, entries);
  let buffer = "";
  let out = "";
  chunks.forEach((chunk, index) => {
    buffer += chunk;
    const final = index === chunks.length - 1;
    const result = restoreText(buffer, matcher, compiled, {
      final,
      maxPlaceholderLength: 128,
      escape: true,
    });
    out += result.out;
    buffer = result.rest;
  });
  return out + buffer;
}

describe("escapeLiteral", () => {
  it("prefix-escapes only template shapes and doubles backslashes (PE-04)", () => {
    expect(escapeLiteral(compiled, "hello")).toBe("hello");
    expect(escapeLiteral(compiled, BS)).toBe(BS + BS);
    expect(escapeLiteral(compiled, "{not a shape}")).toBe("{not a shape}");
    expect(escapeLiteral(compiled, SHAPE)).toBe(BS + SHAPE);
    expect(escapeLiteral(compiled, BS + SHAPE)).toBe(BS + BS + BS + SHAPE);
  });

  it("reports need_more for a bare trailing escape (PE-05)", () => {
    expect(escapeStep(compiled, BS, 0)).toEqual({ kind: "need_more" });
    expect(escapeStep(compiled, BS + BS, 0)).toEqual({ kind: "emit", text: BS, end: 2 });
    expect(escapeStep(compiled, BS + "{", 0)).toEqual({ kind: "emit", text: "{", end: 2 });
  });
});

describe("escape-aware restore", () => {
  it("restores registered tokens and decodes escaped literals (PE-01/PE-13)", () => {
    expect(restoreAll(SHAPE)).toBe("13800138000");
    // An escaped registered placeholder stays a literal and is never restored.
    expect(restoreAll(BS + SHAPE)).toBe(SHAPE);
    expect(restoreAll(`${SHAPE} and ${BS}${SHAPE}`)).toBe(`13800138000 and ${SHAPE}`);
  });

  it("does not decode escapes when escaping is disabled", () => {
    // The backslash stays literal; the registered token still restores.
    expect(restoreAll(BS + SHAPE, false)).toBe(BS + "13800138000");
    expect(restoreAll(BS + "hello", false)).toBe(BS + "hello");
  });

  it("is chunk-invariant across an escape boundary (PE-05)", () => {
    const text = `A ${BS}${SHAPE} B`;
    expect(restoreChunked([text])).toBe(`A ${SHAPE} B`);
    expect(restoreChunked([`A ${BS}`, `${SHAPE} B`])).toBe(`A ${SHAPE} B`);
    const parts = [SHAPE.slice(0, 5), SHAPE.slice(5, 12), SHAPE.slice(12)];
    expect(restoreChunked(["A ", BS, ...parts, " B"])).toBe(`A ${SHAPE} B`);
  });

  it("decodes escaped values inside JSON tool arguments (PE-01)", () => {
    const arg = JSON.stringify({ note: BS + SHAPE });
    const result = restoreJsonText(arg, compiled, entries, 128, true);
    expect(result.parseFailed).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ note: SHAPE });
  });
});

describe("literal text through translate", () => {
  function capturingFetch(): { fetch: typeof fetch; lastBody: () => unknown } {
    let body: unknown;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      body = await req.json();
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "call 13800138000 today" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { fetch: impl, lastBody: () => body };
  }

  function options(content: string): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "sk-key" },
      body: { model: "gpt-4o", max_tokens: 256, messages: [{ role: "user", content }] },
    };
  }

  it("leaves literal text byte-identical by default (INV-A1)", async () => {
    let report: PrivacyCompletionReport | undefined;
    const cap = capturingFetch();
    const literal = `note ${SHAPE} and C:${BS}tmp${BS}x ${BS}d{11}`;
    const response = await translate.chat.messages({
      ...options(`call 13800138000 and ${literal}`),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    const outbound = JSON.stringify(cap.lastBody());
    // The sensitive value is gone, everything else is untouched.
    expect(outbound).not.toContain("13800138000");
    const sent = cap.lastBody() as { messages: { content: string }[] };
    const content = sent.messages[0].content;
    const token = /\{PP-phone-[a-z2-7]{5}\}/.exec(content);
    expect(token).not.toBeNull();
    // Replacing the token with a marker reproduces the input verbatim: no
    // escape character was inserted and no backslash was doubled.
    expect(content.replace(token![0], "{p}")).toBe(`call {p} and ${literal}`);
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0].message.content).toBe("call 13800138000 today");
    expect(report?.redacted).toBe(1);
    expect(report?.escaped).toBe(0);
  });

  it("still escapes when legacy escaping is enabled (PE-02)", async () => {
    let report: PrivacyCompletionReport | undefined;
    const cap = capturingFetch();
    // Shape-identical to the *default* token shape, but not a registered token.
    const literal = "{PP-phone-zzzzz}";
    const response = await translate.chat.messages({
      ...options(`call 13800138000 and note ${literal}`),
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        mapping: { escape: true },
      },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    const sent = cap.lastBody() as { messages: { content: string }[] };
    const content = sent.messages[0].content;
    // Only the caller-supplied literal is escaped; the fresh token replaces the
    // detected value and stays unescaped.
    const token = /\{PP-phone-[a-z2-7]{5}\}/.exec(content)?.[0];
    expect(token).toBeDefined();
    expect(content).toBe(`call ${token} and note ${BS}${literal}`);
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0].message.content).toBe("call 13800138000 today");
    expect(report?.redacted).toBe(1);
    expect(report?.escaped).toBe(1);
  });
});
