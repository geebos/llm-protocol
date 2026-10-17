/**
 * Extension double-evidence (PR-014). Covers PT-29/33/48/61/69.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
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

function openaiOptions(extra: Record<string, unknown>): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "sk" },
    body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    },
  };
}

describe("native field coverage (supersedes extension double evidence)", () => {
  it("allows a native field without evidence by default (PT-29)", async () => {
    const cap = capturingFetch();
    await expect(
      translate.chat.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer sk" },
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          metadata: { a: 1 },
        },
        fetch: cap.fetch,
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).resolves.toBeDefined();
  });

  it("redacts an opt-in native path (PT-29/33/69)", async () => {
    const cap = capturingFetch();
    await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer sk" },
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        metadata: { note: "call 13800138000" },
      },
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { native: { "chat.metadata": "redact" } },
      },
    });
    const metadata = JSON.stringify(cap.lastBody().metadata);
    expect(metadata).not.toContain("13800138000");
    expect(metadata).toContain("<private_placeholder_phone_1>");
  });

  it("rejects a sensitive value in a reject-native path (PT-29)", async () => {
    const cap = capturingFetch();
    await expect(
      translate.chat.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer sk" },
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          metadata: { a: "13800138000" },
        },
        fetch: cap.fetch,
        privacy: {
          recognizers: [phoneRecognizer()],
          coverage: { native: { "chat.metadata": "reject" } },
        },
      }),
    ).rejects.toMatchObject({ code: "privacy_uncovered_channel" });
  });

  it("fails closed on a required native field for a cross-protocol target", async () => {
    const cap = capturingFetch();
    await expect(
      translate.chat.messages({
        ...openaiOptions({ metadata: { a: 1 } }),
        fetch: cap.fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });
});

describe("extension double-evidence unit contract", () => {

  it("fails closed when the codec does not report evidence (PT-48)", () => {
    expect(() =>
      verifyExtensions(
        false,
        undefined,
        [{ path: "extensions.metadata", fieldId: "extensions.metadata", status: "inspected" }],
      ),
    ).toThrow(PrivacyGuardError);
  });

  it("fails closed when forwarding evidence is missing (PT-61)", () => {
    expect(() =>
      verifyExtensions(
        true,
        [],
        [{ path: "extensions.metadata", fieldId: "extensions.metadata", status: "transformed" }],
      ),
    ).toThrow(PrivacyGuardError);
  });

  it("rejects when a redacted field was not forwarded", () => {
    expect(() =>
      verifyExtensions(
        true,
        [{ path: "extensions.metadata", kind: "text", forwarded: false, fieldId: "extensions.metadata" }],
        [{ path: "extensions.metadata", fieldId: "extensions.metadata", status: "inspected" }],
      ),
    ).toThrow(PrivacyGuardError);
  });
});
