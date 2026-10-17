/**
 * Anthropic request native fields (docs/07 §5, L-8 fix).
 *
 * `top_k` / `metadata` / `service_tier` are parsed into the Anthropic native
 * partition and rendered back on a Messages -> Messages round trip; a configured
 * native coverage path redacts them in place.
 */
import { describe, expect, it } from "vitest";
import { translate, type TranslationTrace } from "../../src/index.js";

const PHONE = "13800138000";

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

describe("Anthropic native request fields (L-8)", () => {
  it("round-trips top_k / metadata / service_tier on Messages -> Messages", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "<redacted>" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        top_k: 5,
        metadata: { user_id: "u-1" },
        service_tier: "standard_only",
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
    });
    const body = lastRequest().body;
    expect(body.top_k).toBe(5);
    expect(body.metadata).toEqual({ user_id: "u-1" });
    expect(body.service_tier).toBe("standard_only");
  });

  it("redacts metadata through native coverage", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "<redacted>" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        metadata: { note: `owner ${PHONE}` },
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        coverage: { native: { "anthropic.metadata": "redact" } },
      },
    });
    const metadata = JSON.stringify(lastRequest().body.metadata);
    expect(metadata).not.toContain(PHONE);
    expect(metadata).toContain("<private_placeholder_");
  });

  it("preserves output_config keys other than effort and merges effort", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.messages.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "<redacted>" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: { type: "json" } },
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
    });
    expect(lastRequest().body.output_config).toEqual({
      format: { type: "json" },
      effort: "high",
    });
  });

  it("round-trips redacted_thinking as a native reasoning kind", async () => {
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
            content: [
              { type: "redacted_thinking", data: "ABC" },
              { type: "text", text: "ok" },
            ],
          },
        ],
      },
      fetch,
    });
    const messages = lastRequest().body.messages as Array<{ content: unknown[] }>;
    expect(messages[0].content).toContainEqual({ type: "redacted_thinking", data: "ABC" });
  });

  it("records drops for droppable cross-protocol native fields", async () => {
    const traces: TranslationTrace[] = [];
    const { fetch } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "claude-sonnet",
        max_tokens: 16,
        top_k: 5,
        metadata: { user_id: "u-1" },
        service_tier: "standard_only",
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
      trace: (t) => traces.push(t),
    });
    const drops = traces[0].drops ?? [];
    expect(drops.map((d) => d.path).sort()).toEqual([
      "native.anthropic.metadata",
      "native.anthropic.serviceTier",
      "native.anthropic.topK",
    ]);
    expect(drops.every((d) => d.authorization === "policy_droppable")).toBe(true);
  });

  it("fails closed on a required cross-protocol native field", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(chatResponse));
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer k" },
        body: {
          model: "claude-sonnet",
          max_tokens: 16,
          output_config: { format: { type: "json" } },
          messages: [{ role: "user", content: "hi" }],
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });
});
