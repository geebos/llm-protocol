/**
 * Field-level escaping policy (docs/06 §11, E4).
 *
 * Structural fields (JSON keys, tool ids, value-bearing schema entries) cannot
 * be prefix-escaped, so a shape literal there is rejected with
 * `privacy_field_unescapable` instead of silently passing.
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
    body: { model: "gpt-4o", messages: [{ role: "user", content: "call 13800138000" }], ...body },
  };
}

describe("field-level escaping policy (E4)", () => {
  it("rejects a shape literal in a value-bearing schema entry", async () => {
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          tools: [
            {
              type: "function",
              function: {
                name: "t",
                parameters: {
                  type: "object",
                  properties: { id: { type: "string", enum: ["<private_placeholder_phone_7>"] } },
                },
              },
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_field_unescapable" });
  });

  it("rejects a shape literal in a tool-argument JSON key", async () => {
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          messages: [
            { role: "user", content: "call 13800138000" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "f",
                    arguments: JSON.stringify({ "<private_placeholder_phone_1>": "x" }),
                  },
                },
              ],
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_field_unescapable" });
  });

  it("still accepts a shape-free schema entry", async () => {
    await expect(
      translate.chat.messages({
        ...openaiOptions({
          tools: [
            {
              type: "function",
              function: {
                name: "t",
                parameters: {
                  type: "object",
                  properties: { id: { type: "string", enum: ["ok"] } },
                },
              },
            },
          ],
        }),
        fetch: fetchOk(),
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).resolves.toBeDefined();
  });
});
