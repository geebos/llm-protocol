/**
 * OpenAI Chat response conversion tests.
 *
 * Source protocol: openai-chat. Renders canonical responses to the Anthropic
 * Messages target (tool_use blocks, stop-reason mapping, cache-usage
 * composition) and parses OpenAI finish reasons / usage into canonical.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter, anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CanonicalResponse } from "../../src/ir/response.js";
import type { ContentPart } from "../../src/ir/types.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

{
  const canonical: CanonicalResponse = {
    id: "chatcmpl_1",
    model: "gpt-4o",
    content: [
      { type: "text", text: "Here is the result." },
      { type: "tool_call", id: "call_1", name: "echo", argumentsText: '{"x":1}' },
    ] as ContentPart[],
    finishReason: "tool_call",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  };

  it("renders tool_calls back into Anthropic tool_use blocks", () => {
    const ctx = newCodecContext();
    const body = anthropic.response.renderResponse(canonical, ctx) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "text", text: "Here is the result." },
      { type: "tool_use", id: "call_1", name: "echo", input: { x: 1 } },
    ]);
    expect(body.usage).toMatchObject({ input_tokens: 10, output_tokens: 4 });
  });

  it("warns on content_filter stop reason mapped to end_turn", () => {
    const ctx = newCodecContext();
    anthropic.response.renderResponse(
      { ...canonical, finishReason: "content_filter" },
      ctx,
    );
    expect(ctx.warnings.some((w) => w.code === "stop_reason_lossy")).toBe(true);
  });
}

describe("OpenAI finish_reason and usage mapping", () => {
  it("maps OpenAI finish_reason to canonical", () => {
    const ctx = newCodecContext();
    const parsed = openai.response.parseResponse(
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "length" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    expect(parsed.finishReason).toBe("max_tokens");
    expect(parsed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("maps unknown stop reason to unknown, never guesses", () => {
    const ctx = newCodecContext();
    const parsed = openai.response.parseResponse(
      {
        id: "x",
        choices: [{ index: 0, message: { content: "hi" }, finish_reason: "weird_new_reason" }],
      },
      ctx,
    );
    expect(parsed.finishReason).toBe("unknown");
  });

  it("composes Anthropic cache tokens into OpenAI prompt_tokens (13.4)", () => {
    const ctx = newCodecContext();
    const body = openai.response.renderResponse(
      {
        id: "msg_1",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheCreationTokens: 2 },
      },
      ctx,
    ) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).prompt_tokens).toBe(16);
    expect(ctx.warnings.some((w) => w.code === "cache_usage_approximation")).toBe(true);
  });

  it("parses OpenAI cached_tokens details into canonical cacheReadTokens", () => {
    const ctx = newCodecContext();
    const canonical = openai.response.parseResponse(
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 5,
          total_tokens: 21,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
      ctx,
    );
    expect(canonical.usage?.cacheReadTokens).toBe(4);
    expect(canonical.usage?.reasoningTokens).toBe(2);
  });

  it("reads provider-dialect cache-creation fields only when declared (GAP-014)", () => {
    const dialectProfile = {
      protocol: "openai-chat" as const,
      capabilities: {
        tools: true,
        parallelTools: true,
        streaming: true,
        thinking: false,
        usage: { cacheCreation: true },
      },
      defaultHeaders: {},
    };
    const dialectAdapter = createOpenAiChatAdapter(dialectProfile);
    const ctx = newCodecContext();
    const payload = {
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 16, completion_tokens: 5, cache_write_tokens: 4 },
    };
    const withDialect = dialectAdapter.response.parseResponse(payload, newCodecContext());
    expect(withDialect.usage?.cacheCreationTokens).toBe(4);
    // default profile (no dialect) must NOT read the provider-specific field
    const plain = openai.response.parseResponse(payload, ctx);
    expect(plain.usage?.cacheCreationTokens).toBeUndefined();
  });

  it("regression: OpenAI->OpenAI round trip keeps prompt_tokens (no double cache)", () => {
    // prompt_tokens=16 includes cached_tokens=4; after parse->render the
    // value must stay 16 (canonical inputTokens is pure input = 12).
    const ctx = newCodecContext();
    const canonical = openai.response.parseResponse(
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 5,
          total_tokens: 21,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
      ctx,
    );
    expect(canonical.usage).toMatchObject({ inputTokens: 12, cacheReadTokens: 4, outputTokens: 5, totalTokens: 21 });
    const body = openai.response.renderResponse(canonical, ctx) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).prompt_tokens).toBe(16);
    expect(ctx.warnings.some((w) => w.code === "cache_usage_approximation")).toBe(true);
  });
});
