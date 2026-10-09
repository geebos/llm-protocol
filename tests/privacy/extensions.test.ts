/**
 * Extension double-evidence (PR-014). Covers PT-29/33/48/61/69.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import {
  PrivacyGuardError,
  verifyExtensions,
  type PrivacyRecognizer,
} from "../../src/index.js";

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

interface Capture {
  fetch: typeof fetch;
  lastBody: () => Record<string, unknown>;
}

function capturingFetch(): Capture {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    body = (await req.json()) as Record<string, unknown>;
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
  return { fetch: fetchImpl, lastBody: () => body };
}

function openaiRequest(extra: Record<string, unknown>): Request {
  return new Request("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }),
  });
}

describe("extension double evidence", () => {
  it("allows extensions without evidence by default (PT-29)", async () => {
    const cap = capturingFetch();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    // `metadata` is not representable in Anthropic and is dropped, but the
    // default allow coverage never requires evidence.
    await expect(forward(openaiRequest({ metadata: { a: 1 } }))).resolves.toBeDefined();
  });

  it("redacts an opt-in extension path with consistent evidence (PT-29/33/69)", async () => {
    const cap = capturingFetch();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { extensions: { metadata: "redact" } },
      },
    });
    await forward(openaiRequest({ metadata: { note: "call 13800138000" } }));
    const metadata = JSON.stringify((cap.lastBody() as { metadata?: unknown }).metadata);
    expect(metadata).not.toContain("13800138000");
    expect(metadata).toContain("<private_placeholder_phone_1>");
  });

  it("rejects a rejected extension path that the codec still forwards (PT-29)", async () => {
    const cap = capturingFetch();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { extensions: { metadata: "reject" } },
      },
    });
    await expect(forward(openaiRequest({ metadata: { a: 1 } }))).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_extension_unverifiable",
    });
  });

  it("only allows opaque extension paths to be rejected (PT-29)", async () => {
    const cap = capturingFetch();
    const redactForward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { extensions: { signature: "redact" } },
      },
    });
    await expect(redactForward(openaiRequest({ signature: "abc" }))).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_extension_unverifiable",
    });

    const rejectForward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { extensions: { signature: "reject" } },
      },
    });
    await expect(rejectForward(openaiRequest({ signature: "abc" }))).resolves.toBeDefined();
  });

  it("fails closed when the codec does not report evidence (PT-48)", () => {
    expect(() =>
      verifyExtensions(false, undefined, [{ path: "extensions.metadata", action: "redact" }], []),
    ).toThrow(PrivacyGuardError);
  });

  it("fails closed when forwarding evidence is missing (PT-61)", () => {
    expect(() =>
      verifyExtensions(true, [], [{ path: "extensions.metadata", action: "redact" }], []),
    ).toThrow(PrivacyGuardError);
  });

  it("rejects when a redacted field was not forwarded", () => {
    expect(() =>
      verifyExtensions(
        true,
        [{ path: "extensions.metadata", kind: "text", forwarded: false, fieldId: "extensions.metadata" }],
        [{ path: "extensions.metadata", action: "redact" }],
        [],
      ),
    ).toThrow(PrivacyGuardError);
  });
});
