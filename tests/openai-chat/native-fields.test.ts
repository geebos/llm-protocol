/**
 * Chat native request fields (docs/07 §5, P5-2).
 *
 * Presence/shape (max_tokens vs max_completion_tokens) and native fields
 * round-trip on Chat -> Chat; cross-protocol they follow the policy table
 * (store value-dependent, metadata required).
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

describe("Chat native request fields (P5-2)", () => {
  it("round-trips native fields and the max_completion_tokens shape on Chat -> Chat", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "gpt-4o",
        max_completion_tokens: 64,
        metadata: { user_id: "u1" },
        store: false,
        service_tier: "flex",
        n: 1,
        logprobs: true,
        top_logprobs: 3,
        response_format: { type: "json_object" },
        user: "u1",
        stream_options: { include_usage: true, chunk_size: 4 },
        x_custom: "kept",
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
    });
    const body = lastRequest().body;
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
    expect(body.metadata).toEqual({ user_id: "u1" });
    expect(body.store).toBe(false);
    expect(body.service_tier).toBe("flex");
    expect(body.n).toBe(1);
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(3);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.user).toBe("u1");
    // include_usage is the IR hint; other stream_options keys are native.
    expect(body.stream_options).toEqual({ chunk_size: 4 });
    expect(body.x_custom).toBe("kept");
  });

  it("drops store:false but fails closed on store:true for an Anthropic target", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "k" },
        body: { model: "gpt-4o", store: false, messages: [{ role: "user", content: "hi" }] },
        fetch,
      }),
    ).resolves.toBeDefined();

    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": "k" },
        body: { model: "gpt-4o", store: true, messages: [{ role: "user", content: "hi" }] },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });
});
