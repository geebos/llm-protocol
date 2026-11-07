/**
 * OpenAI image sources (openai-chat -> anthropic-messages).
 *
 * Base64 data URLs become canonical base64 sources (`media_type`) instead of
 * invalid `url` sources; http(s) URLs stay url sources. The same rule applies
 * to images carried inside tool messages.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";

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

const TARGET_URL = "https://api.anthropic.com/v1/messages";
const HEADERS = { "x-api-key": "k" };

function renderedMessages(body: Record<string, unknown>): Array<{ content: unknown }> {
  return body.messages as Array<{ content: unknown }>;
}

describe("OpenAI image source -> Anthropic", () => {
  it("converts a base64 data URL to a base64 source with media_type", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            ],
          },
        ],
      },
      fetch,
    });
    expect(renderedMessages(lastRequest().body)[0].content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
    ]);
  });

  it("keeps an http image URL as a url source", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
        model: "m",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
          },
        ],
      },
      fetch,
    });
    expect(renderedMessages(lastRequest().body)[0].content).toEqual([
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
  });

  it("converts a data URL image inside a tool message to base64", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "t1", type: "function", function: { name: "read_image", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "t1",
            content: [
              { type: "text", text: "saved" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
            ],
          },
        ],
        tools: [
          { type: "function", function: { name: "read_image", parameters: { type: "object" } } },
        ],
      },
      fetch,
    });
    const blocks = renderedMessages(lastRequest().body).flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [],
    );
    const toolResult = blocks.find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(toolResult?.content).toEqual([
      { type: "text", text: "saved" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BBBB" },
      },
    ]);
  });

  it("leaves a base64 data URL unchanged on Chat -> Chat", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
      fetch,
    });
    const messages = lastRequest().body.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
