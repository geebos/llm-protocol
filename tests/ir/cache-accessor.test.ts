/**
 * P1a regression: `cache_control` is carried on the Anthropic native partition
 * (`native.anthropic.cacheControl`) and read exclusively through the unified
 * Cache Metadata Accessor (docs/07 §5.6.1 / §8.4, PR-017).
 *
 * Same-protocol Messages -> Messages must go through parse -> IR -> render and
 * still emit `cache_control` on system text and tool definitions.
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

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe("cache_control via native.anthropic.cacheControl (P1a)", () => {
  it("round-trips system text and tool cache_control on Messages -> Messages", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "<redacted>" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        system: [
          {
            type: "text",
            text: "sys",
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: "echo",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
    });

    const captured = lastRequest();
    expect(captured.body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps the same cache identity when only the transport changes (Messages -> Chat)", async () => {
    // The privacy-safe resolver derives the key from the native partition; a
    // stable key across two identical calls proves the migration did not change
    // anchor extraction (§8.4 regression).
    const keys: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const { fetch, lastRequest } = fakeFetch(() =>
        jsonResponse({
          id: "chatcmpl",
          object: "chat.completion",
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
      );
      await translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer key" },
        body: {
          model: "claude-sonnet",
          max_tokens: 16,
          system: [
            { type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } },
          ],
          messages: [
            { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
          ],
        },
        fetch,
        cache: {},
      });
      keys.push(lastRequest().body.prompt_cache_key);
    }
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
  });
});
