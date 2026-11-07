/**
 * Anthropic tool_result content rendering (regression).
 *
 * tool_result content that mixes text with non-text parts is rendered through
 * the canonical IR. It must use Anthropic wire names (`media_type`) rather
 * than IR camelCase (`mediaType`), and preserve cache_control metadata.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

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

function messagesBody(userContent: unknown): Record<string, unknown> {
  return {
    model: "claude-sonnet",
    max_tokens: 64,
    stream: false,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_image", input: {} }],
      },
      { role: "user", content: userContent },
    ],
    tools: [
      {
        name: "read_image",
        description: "d",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

async function renderToolResult(content: unknown): Promise<Record<string, unknown>> {
  const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
  await translate.messages.messages({
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "test-key" },
    body: messagesBody([{ type: "tool_result", tool_use_id: "t1", content }]),
    fetch,
  });
  const messages = lastRequest().body.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  const toolResult = messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result");
  if (!toolResult) throw new Error("no tool_result rendered");
  return toolResult;
}

describe("Anthropic tool_result content rendering", () => {
  it("renders a base64 image beside text with media_type (not mediaType)", async () => {
    const block = await renderToolResult([
      { type: "text", text: "saved" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
    ]);
    expect(block.content).toEqual([
      { type: "text", text: "saved" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
    ]);
    expect(JSON.stringify(block)).not.toContain("mediaType");
  });

  it("renders a single-image tool_result with media_type", async () => {
    const block = await renderToolResult([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
      },
    ]);
    expect(block.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
      },
    ]);
    expect(JSON.stringify(block)).not.toContain("mediaType");
  });

  it("keeps a plain string tool_result as a string", async () => {
    const block = await renderToolResult("done");
    expect(block.content).toBe("done");
  });

  it("keeps a text-only block array joined into a string", async () => {
    const block = await renderToolResult([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(block.content).toBe("ab");
  });

  it("preserves cache_control on a text part mixed with an image", async () => {
    const block = await renderToolResult([
      {
        type: "text",
        text: "cached",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ]);
    expect(block.content).toEqual([
      {
        type: "text",
        text: "cached",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ]);
  });

  it("renders a top-level user image with media_type (control)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "test-key" },
      body: {
        model: "claude-sonnet",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAA" },
              },
            ],
          },
        ],
      },
      fetch,
    });
    const messages = lastRequest().body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });
});
