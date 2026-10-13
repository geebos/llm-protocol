/**
 * Provenance-aware reversible escaping (docs/06). Covers PE-01..PE-05/PE-13.
 *
 * External literals that look like placeholders are escaped on the request and
 * decoded on the response (single pass, `D(E(x)) = x`), so they no longer fail
 * closed as collisions or unknown shapes.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyCompletionReport, PrivacyRecognizer } from "../../src/index.js";
import { compileTemplate } from "../../src/privacy/template.js";
import { escapeLiteral, escapeStep } from "../../src/privacy/escape.js";
import { restoreJsonText, restoreText } from "../../src/privacy/restore.js";
import { createPlaceholderMatcher } from "../../src/privacy/trie.js";

const compiled = compileTemplate("<private_placeholder_{type}_{N}>");

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

const entries = [
  { placeholder: "<private_placeholder_phone_1>", original: "13800138000" },
];

function restoreAll(text: string): string {
  const result = restoreText(text, createPlaceholderMatcher(compiled, entries), compiled, {
    final: true,
    maxPlaceholderLength: 128,
  });
  return result.out + result.rest;
}

/** Feed chunk by chunk through the streaming decoder (shared FST). */
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
    });
    out += result.out;
    buffer = result.rest;
  });
  return out + buffer;
}

describe("escapeLiteral", () => {
  it("prefix-escapes only template shapes and doubles backslashes (PE-04)", () => {
    expect(escapeLiteral(compiled, "hello")).toBe("hello");
    expect(escapeLiteral(compiled, "\\")).toBe("\\\\");
    expect(escapeLiteral(compiled, "<not a shape>")).toBe("<not a shape>");
    expect(escapeLiteral(compiled, "<private_placeholder_phone_1>")).toBe(
      "\\<private_placeholder_phone_1>",
    );
    expect(escapeLiteral(compiled, "\\<private_placeholder_phone_1>")).toBe(
      "\\\\\\<private_placeholder_phone_1>",
    );
  });

  it("reports need_more for a bare trailing escape (PE-05)", () => {
    expect(escapeStep(compiled, "\\", 0)).toEqual({ kind: "need_more" });
    expect(escapeStep(compiled, "\\\\", 0)).toEqual({
      kind: "emit",
      text: "\\",
      end: 2,
    });
    expect(escapeStep(compiled, "\\<", 0)).toEqual({ kind: "emit", text: "<", end: 2 });
  });
});

describe("escape-aware restore", () => {
  it("restores registered tokens and decodes escaped literals (PE-01/PE-13)", () => {
    expect(restoreAll("<private_placeholder_phone_1>")).toBe("13800138000");
    // An escaped registered placeholder stays a literal and is never restored.
    expect(restoreAll("\\<private_placeholder_phone_1>")).toBe(
      "<private_placeholder_phone_1>",
    );
    expect(
      restoreAll("<private_placeholder_phone_1> and \\<private_placeholder_phone_1>"),
    ).toBe("13800138000 and <private_placeholder_phone_1>");
  });

  it("is chunk-invariant across an escape boundary (PE-05)", () => {
    const text = "A \\<private_placeholder_phone_1> B";
    expect(restoreChunked([text])).toBe("A <private_placeholder_phone_1> B");
    expect(restoreChunked(["A \\", "<private_placeholder_phone_1> B"])).toBe(
      "A <private_placeholder_phone_1> B",
    );
    expect(restoreChunked(["A ", "\\", "<private_", "placeholder_phone_1>", " B"])).toBe(
      "A <private_placeholder_phone_1> B",
    );
  });

  it("decodes escaped values inside JSON tool arguments (PE-01)", () => {
    const arg = JSON.stringify({ note: "\\<private_placeholder_phone_1>" });
    const result = restoreJsonText(arg, compiled, entries, 128);
    expect(result.parseFailed).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ note: "<private_placeholder_phone_1>" });
  });
});

describe("escaped literals through translate", () => {
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

  it("escapes an external literal that equals the generated placeholder (PE-02)", async () => {
    let report: PrivacyCompletionReport | undefined;
    const cap = capturingFetch();
    const response = await translate.chat.messages({
      ...options("call 13800138000 and note <private_placeholder_phone_1>"),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    const outbound = JSON.stringify(cap.lastBody());
    expect(outbound).not.toContain("13800138000");
    // The external literal is prefix-escaped (backslash encoded as \\ in JSON).
    expect(outbound).toContain("\\\\<private_placeholder_phone_1>");
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0].message.content).toBe("call 13800138000 today");
    expect(report?.redacted).toBe(1);
    expect(report?.escaped).toBe(1);
  });

  it("still fails closed when escaping is disabled (PE-15)", async () => {
    const cap = capturingFetch();
    await expect(
      translate.chat.messages({
        ...options("call 13800138000 and note <private_placeholder_phone_1>"),
        fetch: cap.fetch,
        privacy: {
          recognizers: [phoneRecognizer()],
          mapping: { escape: false },
        },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_placeholder_collision" });
  });
});
