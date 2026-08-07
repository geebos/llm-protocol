/**
 * tech-v2.md M7.2/M7.3 compatibility fixtures: NONSTREAM-001 .. NONSTREAM-005
 * plus cache-usage semantics.
 *
 * Covers request-side semantics (parallel_tool_calls, reasoning_effort,
 * adaptive thinking, Anthropic turn normalization) and usage token
 * composition/splitting. End-to-end cases go through the public translate()
 * factory; focused round-trips use the codecs directly.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { createAnthropicAdapter, anthropicDefaultProfile, normalizeAnthropicTurns } from "../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../src/codecs/protocol-adapter.js";
import type { CanonicalMessage } from "../src/ir/types.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

function openaiChatRequest(body: Record<string, unknown>): Request {
  return new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false, ...body }),
  });
}

async function translateCapturing(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = (await req.json()) as Record<string, unknown>;
    return fetchImpl(req);
  }) as typeof fetch;
  const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
  await forward(openaiChatRequest(body));
  return captured;
}

function openAiJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("NONSTREAM-001 parallel_tool_calls=false round trip", () => {
  it("maps parallel_tool_calls=false -> disable_parallel_tool_use=true and back", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
        parallel_tool_calls: false,
      },
      ctx,
    );
    expect(canonical.parallelToolCalls).toBe(false);

    const anthropicBody = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(anthropicBody.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });

    const back = anthropic.request.parseRequest(
      {
        model: "gpt-4o",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "echo", input_schema: { type: "object" } }],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      },
      newCodecContext(),
    );
    expect(back.parallelToolCalls).toBe(false);

    const openAiBody = openai.request.renderRequest(back, false, ctx) as Record<string, unknown>;
    expect(openAiBody.parallel_tool_calls).toBe(false);
  });

  it("through translate(): target receives disable_parallel_tool_use=true", async () => {
    const captured = await translateCapturing(
      { parallel_tool_calls: false, messages: [{ role: "user", content: "hi" }] },
      openAiJsonResponse,
    );
    expect(captured.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});

describe("NONSTREAM-002 reasoning_effort", () => {
  it("maps OpenAI reasoning_effort into adaptive thinking effort", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      ctx,
    );
    expect(canonical.thinking).toEqual({ mode: "adaptive", effort: "high" });

    const anthropicBody = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(anthropicBody.thinking).toEqual({ type: "adaptive" });
    expect(anthropicBody.output_config).toEqual({ effort: "high" });
  });

  it("through translate(): target receives adaptive thinking with effort", async () => {
    const captured = await translateCapturing(
      { reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
      openAiJsonResponse,
    );
    expect(captured.thinking).toEqual({ type: "adaptive" });
    expect(captured.output_config).toEqual({ effort: "high" });
  });

  it("round-trips an unknown effort value losslessly via extensions", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "turbo",
      },
      ctx,
    );
    // not a known effort -> preserved as an extension, not guessed
    expect(canonical.thinking).toBeUndefined();
    expect(canonical.extensions?.reasoning_effort).toBe("turbo");
    const body = openai.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("turbo");
  });
});

describe("NONSTREAM-003 adaptive thinking config", () => {
  it("parses thinking.type=adaptive + output_config.effort into IR and back", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "solve" }],
      },
      ctx,
    );
    expect(canonical.thinking).toEqual({ mode: "adaptive", effort: "high" });

    const body = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("keeps enabled + budget_tokens round trip", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        thinking: { type: "enabled", budget_tokens: 500 },
        messages: [{ role: "user", content: "solve" }],
      },
      ctx,
    );
    expect(canonical.thinking).toEqual({ mode: "enabled", budgetTokens: 500 });
    const body = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 500 });
  });
});

describe("NONSTREAM-004 multi tool_result ordering", () => {
  const toolFlowMessages = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"city":"Paris"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "sunny, 25C" },
    { role: "tool", tool_call_id: "call_b", content: "14:00" },
    { role: "user", content: "thanks" },
  ];

  it("normalizes to a single Anthropic user turn with tool_result first", async () => {
    const captured = await translateCapturing(
      { messages: toolFlowMessages as never },
      openAiJsonResponse,
    );
    const msgs = captured.messages as Array<{ role: string; content: unknown }>;
    const userTurns = msgs.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);
    const blocks = userTurns[0].content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(blocks[0]).toMatchObject({ tool_use_id: "call_a" });
    expect(blocks[1]).toMatchObject({ tool_use_id: "call_b" });
    expect(blocks[2]).toMatchObject({ type: "text", text: "thanks" });
  });

  it("normalizeAnthropicTurns merges consecutive same-role turns and reports", () => {
    const ctx = newCodecContext();
    const input: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [{ type: "text", text: "r1" }] }] },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
    ];
    const out = normalizeAnthropicTurns(input, ctx);
    expect(out).toHaveLength(2);
    expect(out[0].content.map((p) => p.type)).toEqual(["tool_result", "text"]);
    expect(ctx.warnings.some((w) => w.code === "merged_consecutive_turns")).toBe(true);
    expect(ctx.warnings.some((w) => w.code === "tool_result_reordered")).toBe(true);
  });
});

describe("NONSTREAM-005 cache usage semantics", () => {
  it("composes Anthropic cache tokens into OpenAI prompt_tokens (13.4)", () => {
    const ctx = newCodecContext();
    const body = openai.response.renderResponse(
      {
        id: "msg_1",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        finishReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 4,
          cacheCreationTokens: 2,
        },
      },
      ctx,
    ) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).prompt_tokens).toBe(16);
    expect(ctx.warnings.some((w) => w.code === "cache_usage_approximation")).toBe(true);
  });

  it("splits OpenAI cached tokens out of Anthropic input_tokens (13.5)", () => {
    const ctx = newCodecContext();
    const body = anthropic.response.renderResponse(
      {
        id: "chatcmpl_1",
        model: "gpt-4o",
        content: [{ type: "text", text: "ok" }],
        finishReason: "end_turn",
        usage: {
          inputTokens: 16,
          outputTokens: 5,
          cacheReadTokens: 4,
        },
      },
      ctx,
    ) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(12);
    expect((body.usage as Record<string, unknown>).cache_read_input_tokens).toBe(4);
    expect(ctx.warnings.some((w) => w.code === "cache_usage_approximation")).toBe(true);
  });

  it("clamps Anthropic input_tokens at zero", () => {
    const ctx = newCodecContext();
    const body = anthropic.response.renderResponse(
      {
        id: "x",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 5 },
      },
      ctx,
    ) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(0);
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
});
