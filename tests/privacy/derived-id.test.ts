/**
 * Deterministic HMAC-derived placeholder identifiers (docs/06 §10.2, E5).
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyRecognizer } from "../../src/index.js";
import { compileTemplate, derivedPlaceholderN } from "../../src/privacy/template.js";
import { PrivacySession, type SessionConfig } from "../../src/privacy/session.js";

const compiled = compileTemplate("<private_placeholder_{type}_{N}>");
const key = new Uint8Array(32).fill(7);

function config(): SessionConfig {
  return {
    compiled,
    tagMode: false,
    tagBytes: 12,
    namespace: "tenant",
    tagKey: key,
    idMode: "derived",
    contextId: "conv-1",
  };
}

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

function capturingFetch(): { fetch: typeof fetch; lastBody: () => unknown } {
  let body: unknown;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    body = await req.json();
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
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
    body: { model: "gpt-4o", messages: [{ role: "user", content }] },
  };
}

describe("derived placeholder ids (E5)", () => {
  it("is stable across sessions and bound to the value", () => {
    const a = new PrivacySession("a", config());
    const b = new PrivacySession("b", config());
    const ea = a.getOrCreate("phone", "13800138000");
    const eb = b.getOrCreate("phone", "13800138000");
    expect(ea.placeholder).toBe(eb.placeholder);
    expect(ea.placeholder).toBe(
      `<private_placeholder_phone_${derivedPlaceholderN(key, "conv-1", "phone", "13800138000")}>`,
    );
    expect(a.getOrCreate("phone", "13900139000").placeholder).not.toBe(ea.placeholder);
    // Idempotent within a session.
    expect(a.getOrCreate("phone", "13800138000")).toBe(ea);
  });

  it("uses length-prefixed encoding so field splits do not alias", () => {
    expect(derivedPlaceholderN(key, "ab", "c", "x")).not.toBe(
      derivedPlaceholderN(key, "a", "bc", "x"),
    );
  });

  it("requires tagKey and tagContextId", async () => {
    await expect(
      translate.chat.messages({
        ...options("call 13800138000"),
        fetch: capturingFetch().fetch,
        privacy: { recognizers: [phoneRecognizer()], mapping: { idMode: "derived" } },
      }),
    ).rejects.toThrow(/idMode/);
  });

  it("keeps the placeholder stable across requests (E5)", async () => {
    const cap = capturingFetch();
    const run = (content: string) =>
      translate.chat.messages({
        ...options(content),
        fetch: cap.fetch,
        privacy: {
          recognizers: [phoneRecognizer()],
          tagKey: () => key,
          mapping: { idMode: "derived", tagContextId: "conv-1" },
        },
      });
    await run("first call 13800138000");
    const first = JSON.stringify(cap.lastBody());
    await run("a different prefix, call 13800138000 too");
    const second = JSON.stringify(cap.lastBody());
    const re = /<private_placeholder_phone_(\d+)>/;
    const firstN = first.match(re)?.[1];
    expect(firstN).toBeDefined();
    expect(second.match(re)?.[1]).toBe(firstN);
  });
});
