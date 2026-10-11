/**
 * Coverage Policy and EgressVerify (P2/P6). Covers PT-18/29/33/38/52/62/66.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyRecognizer } from "../../src/index.js";

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

function fetchOk(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function openaiOptions(body: Record<string, unknown>): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "sk-key" },
    body: { model: "gpt-4o", ...body },
  };
}

describe("coverage policy", () => {
  it("rejects a collision with a default-allow extension (PT-62)", async () => {
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          metadata: { note: "<private_placeholder_phone_1>" },
          messages: [{ role: "user", content: "call 13800138000" }],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_placeholder_collision" });
  });

  it("rejects a sensitive value in a reasoning channel (PT-18)", async () => {
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer sk" },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "call 13800138000", signature: "sig" }],
            },
          ],
        },
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_signature_guard",
    });
  });

  it("rejects a sensitive value bearing schema entry, not a benign one (PT-38/52)", async () => {
    // Benign schema: passes.
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "t",
                description: "lookup a record",
                parameters: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).resolves.toBeDefined();

    // Sensitive enum value: rejected.
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "t",
                parameters: { type: "object", properties: { id: { enum: ["13800138000"] } } },
              },
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_uncovered_channel" });
  });

  it("honours allow in policy egress but not in strict egress (PT-66)", async () => {
    const request = () =>
      openaiOptions({
        messages: [
          { role: "system", content: "owner 13800138000" },
          { role: "user", content: "call 13800138000" },
        ],
      });

    await expect(
      translate.chat.messages({
        ...request(),
        fetch: fetchOk(),
        privacy: {
          recognizers: [phoneRecognizer()],
          coverage: { message_text: "allow" },
        },
      }),
    ).resolves.toBeDefined();

    await expect(
      translate.chat.messages({
        ...request(),
        fetch: fetchOk(),
        privacy: {
          recognizers: [phoneRecognizer()],
          coverage: { message_text: "allow" },
          egress: "strict",
        },
      }),
    ).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_uncovered_channel",
    });
  });

  it("rejects an unrecognized placeholder shape reaching egress", async () => {
    // A placeholder-shaped literal in an allow extension, plus a real mapping
    // from the message channel, makes the engine emit a foreign shape.
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          metadata: { note: "<private_placeholder_phone_7>" },
          messages: [{ role: "user", content: "call 13800138000" }],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toBeDefined();
  });

  it("rejects oversized tool arguments (PT-40)", async () => {
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "f", arguments: JSON.stringify({ x: "1".repeat(500) }) },
                },
              ],
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: {
          recognizers: [phoneRecognizer()],
          streaming: { maxToolArgumentBytes: 100 },
        },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_buffer_overflow" });
  });
});
