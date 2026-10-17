/**
 * Unknown Anthropic content blocks -> OpaqueNativePart (docs/07 §5.4, L-9).
 *
 * Same-protocol: preserved and rendered back. Cross-protocol: fail-closed
 * (`non_droppable_field`). Privacy: detection-gated reject.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";

const PHONE = "13800138000";

interface Captured {
  body: Record<string, unknown>;
}

function fakeFetch(response: () => Response): {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  lastRequest: () => Captured;
} {
  let captured: Captured | undefined;
  return {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      captured = { body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      return response();
    },
    lastRequest: () => {
      if (!captured) throw new Error("no request captured");
      return captured;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const chatResponse = {
  id: "chatcmpl_1",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

function phoneRecognizer() {
  return {
    priority: 1,
    recognize: (text: string) => {
      const i = text.indexOf(PHONE);
      return i < 0 ? [] : [{ start: i, end: i + PHONE.length, type: "phone" }];
    },
  };
}

const unknownBlock = { type: "server_tool_use", id: "srv_1", input: { q: "x" } };

describe("unknown Anthropic block (L-9)", () => {
  it("round-trips an unknown block on Messages -> Messages", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "<redacted>" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [unknownBlock, { type: "text", text: "ok" }],
          },
        ],
      },
      fetch,
    });
    const messages = lastRequest().body.messages as Array<{ content: unknown[] }>;
    expect(messages[0].content).toContainEqual(unknownBlock);
  });

  it("fails closed on an unknown block for a Chat target", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(chatResponse));
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer k" },
        body: {
          model: "claude-sonnet",
          max_tokens: 16,
          messages: [{ role: "assistant", content: [unknownBlock] }],
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });

  it("rejects a sensitive value inside an unknown block", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    await expect(
      translate.messages.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "<redacted>" },
        body: {
          model: "claude-sonnet",
          max_tokens: 16,
          messages: [
            {
              role: "assistant",
              content: [{ type: "server_tool_use", input: { q: `call ${PHONE}` } }],
            },
          ],
        },
        fetch,
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({ kind: "privacy", code: "privacy_uncovered_channel" });
  });
});
