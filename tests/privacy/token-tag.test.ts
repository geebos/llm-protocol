/**
 * Tag-derived placeholder identity (docs/06 §10.2).
 *
 * The tag is `HMAC-SHA256(key, namespace, type, value)` truncated to 5 base32
 * characters, so a token's identity is its tag: no counter is needed, the same
 * value maps to the same token inside a session, and a caller-supplied key
 * keeps it stable across requests.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyRecognizer } from "../../src/index.js";
import { compileTemplate, tokenTag } from "../../src/privacy/template.js";
import { PrivacySession, type SessionConfig } from "../../src/privacy/session.js";

const compiled = compileTemplate("private_placeholder_");
const key = new Uint8Array(32).fill(7);
const TOKEN_RE = /\{private_placeholder-phone-([a-z2-7]{5})/;

function config(sessionKey: Uint8Array): SessionConfig {
  return { compiled, namespace: "tenant", tagKey: sessionKey };
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

describe("tag identity", () => {
  it("is deterministic for the same (type, value)", () => {
    const a = new PrivacySession("a", config(key));
    const b = new PrivacySession("b", config(key));
    const ea = a.getOrCreate("phone", "13800138000");
    const eb = b.getOrCreate("phone", "13800138000");
    expect(ea.placeholder).toBe(eb.placeholder);
    expect(ea.placeholder).toBe(
      `{private_placeholder-phone-${tokenTag(key, "tenant", "phone", "13800138000", 5)}}`,
    );
    expect(a.getOrCreate("phone", "13900139000").placeholder).not.toBe(ea.placeholder);
    // Idempotent within a session.
    expect(a.getOrCreate("phone", "13800138000")).toBe(ea);
  });

  it("uses a 5-character base32 tag and no counter", () => {
    const session = new PrivacySession("shape", config(key));
    const entry = session.getOrCreate("phone", "13800138000");
    expect(entry.placeholder).toMatch(/^\{private_placeholder-phone-[a-z2-7]{5}\}$/);
    expect(entry.id).toBe(`phone:${TOKEN_RE.exec(entry.placeholder)![1]}`);
  });

  it("shares the per-process key when no caller key is supplied", () => {
    const a = new PrivacySession("a1", { compiled, namespace: "tenant" });
    const b = new PrivacySession("b1", { compiled, namespace: "tenant" });
    // Same process => same tokens, so prompt-cache affinity survives.
    expect(a.getOrCreate("phone", "13800138000").placeholder).toBe(
      b.getOrCreate("phone", "13800138000").placeholder,
    );
    // A caller key changes the namespace of the tag.
    expect(a.getOrCreate("phone", "13800138000").placeholder).not.toBe(
      new PrivacySession("c1", config(key)).getOrCreate("phone", "13800138000").placeholder,
    );
  });

  it("uses length-prefixed encoding so field splits do not alias", () => {
    expect(tokenTag(key, "ab", "c", "x", 5)).not.toBe(tokenTag(key, "a", "bc", "x", 5));
  });

  it("keeps the token stable across requests with a caller key", async () => {
    const cap = capturingFetch();
    const run = (content: string) =>
      translate.chat.messages({
        ...options(content),
        fetch: cap.fetch,
        // Both chains are one conversation: the token must not move.
        privacy: { recognizers: [phoneRecognizer()], tagKey: () => key },
      });
    await run("first call 13800138000");
    const first = JSON.stringify(cap.lastBody());
    await run("a different prefix, call 13800138000 too");
    const second = JSON.stringify(cap.lastBody());
    const pipelineToken = /\{PP-phone-([a-z2-7]{5})\}/;
    const firstTag = pipelineToken.exec(first)?.[1];
    expect(firstTag).toBeDefined();
    expect(pipelineToken.exec(second)?.[1]).toBe(firstTag);
  });
});
