/**
 * Message-role preservation (docs/07 §5.2, L-1) and independent system-notice
 * injection (E-5).
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";

interface Captured {
  url: string;
  headers: Headers;
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
      captured = {
        url: request.url,
        headers: request.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
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

const chatResponse = {
  id: "chatcmpl_1",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe("Chat role preservation (L-1)", () => {
  it("keeps system then developer order and content on Chat -> Chat", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "sys one" },
          { role: "developer", content: "dev two" },
          { role: "user", content: "hi" },
        ],
      },
      fetch,
    });
    expect(lastRequest().body.messages).toEqual([
      { role: "system", content: "sys one" },
      { role: "developer", content: "dev two" },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("system notice injection (E-5)", () => {
  it("injects the notice as a leading system message without mutating developer", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "gpt-4o",
        messages: [
          { role: "developer", content: "dev rules" },
          { role: "user", content: "hi" },
        ],
      },
      fetch,
      privacy: { recognizers: [{ priority: 1, recognize: () => [] }], system: "default" },
    });
    const messages = lastRequest().body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "developer", content: "dev rules" });
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toContain("Privacy notice");
  });
});

describe("role capability gating (P4b)", () => {
  it("fails closed on a developer message for an Anthropic target", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "k" },
        body: {
          model: "gpt-4o",
          messages: [
            { role: "developer", content: "rules" },
            { role: "user", content: "hi" },
          ],
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });

  it("fails closed on a mid-conversation system message for an Anthropic target", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "k" },
        body: {
          model: "gpt-4o",
          messages: [
            { role: "user", content: "hi" },
            { role: "system", content: "late rule" },
            { role: "user", content: "again" },
          ],
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });
});
