/**
 * Anthropic Messages request conversion tests.
 *
 * Source protocol: anthropic-messages. Renders canonical requests to the
 * OpenAI Chat target (reasoning fields, tool adjacency, billing-header
 * stripping, images) plus Anthropic-specific request semantics (adaptive
 * thinking config, tool_result turn normalization).
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter, anthropicDefaultProfile, normalizeAnthropicTurns } from "../../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CanonicalMessage } from "../../src/ir/types.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

{
  const anthropicReq = {
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    stream: false,
    system: [{ type: "text", text: "sys" }],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "sig-1" },
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "echo", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: true },
        ],
      },
    ],
    tools: [{ name: "echo", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "echo" },
    temperature: 0.3,
  };

  it("renders reasoning field, tool messages and error tool results", () => {
    const profile = {
      protocol: "openai-chat" as const,
      capabilities: {
        tools: true,
        parallelTools: true,
        streaming: true,
        thinking: true,
        reasoningField: "reasoning_content",
      },
      defaultHeaders: {},
    };
    const openaiWithReasoning = createOpenAiChatAdapter(profile);
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(anthropicReq, ctx);
    const body = openaiWithReasoning.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;

    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "reasoning",
    });
    expect((msgs[1].tool_calls as Array<Record<string, unknown>>)[0].function).toEqual({
      name: "echo",
      arguments: '{"x":1}',
    });
    // is_error preserved -> OpenAI has no is_error; rendered as ordinary tool message
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "toolu_1", content: "done" });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "echo" } });
    expect((body.tools as Array<Record<string, unknown>>)[0].function).toMatchObject({
      name: "echo",
      description: "d",
    });
  });

  it("round-trips an opaque thinking signature to a declared Chat field (P1-2 request)", () => {
    const profile = {
      protocol: "openai-chat" as const,
      capabilities: {
        tools: true,
        parallelTools: true,
        streaming: true,
        thinking: true,
        reasoningField: "reasoning_content",
        reasoning: { text: true, opaqueSignature: true, signatureField: "thinking_signature" },
      },
      defaultHeaders: {},
    };
    const openaiWithReasoning = createOpenAiChatAdapter(profile);
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(anthropicReq, ctx);
    const body = openaiWithReasoning.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "reasoning",
      thinking_signature: "sig-1",
    });
    // signature stays opaque in IR: no warnings about dropping it
    expect(ctx.warnings.some((w) => w.code === "thinking_signature_dropped")).toBe(false);
  });

  it("parses an assistant signature back into IR signature (P1-2 request parse)", () => {
    const profile = {
      protocol: "openai-chat" as const,
      capabilities: {
        tools: true,
        parallelTools: true,
        streaming: true,
        thinking: true,
        reasoningField: "reasoning_content",
        reasoning: { text: true, opaqueSignature: true, signatureField: "thinking_signature" },
      },
      defaultHeaders: {},
    };
    const openaiWithReasoning = createOpenAiChatAdapter(profile);
    const ctx = newCodecContext();
    const canonical = openaiWithReasoning.request.parseRequest(
      {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            reasoning_content: "chain",
            thinking_signature: "SIG-XYZ",
          },
        ],
      },
      ctx,
    );
    const part = canonical.messages[0].content[0];
    expect(part.type).toBe("reasoning");
    if (part.type === "reasoning") {
      expect(part.text).toBe("chain");
      expect(part.signature).toBe("SIG-XYZ");
    }
  });

  it("drops the Anthropic billing header from system when targeting OpenAI", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.153.3d1; cc_entrypoint=cli; cch=9a10e;",
          },
          { type: "text", text: "You are a helpful assistant." },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      ctx,
    );
    const body = openai.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(JSON.stringify(body)).not.toContain("x-anthropic-billing-header");
    expect(JSON.stringify(body)).not.toContain("cch=9a10e");
    expect(ctx.warnings.some((w) => w.code === "anthropic_billing_header_dropped")).toBe(true);
  });

  it("omits the system message when it only contains a billing header", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: true,
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.153.3d1; cc_entrypoint=cli; cch=9a10e;",
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      ctx,
    );
    const body = openai.request.renderRequest(canonical, true, ctx) as Record<string, unknown>;
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect(ctx.warnings.some((w) => w.code === "anthropic_billing_header_dropped")).toBe(true);
  });
}

{
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
}

{
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
}
describe("images and base64 lossy warning", () => {
  it("renders a URL image to OpenAI image_url", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://x/y.png" } },
              { type: "text", text: "what is this" },
            ],
          },
        ],
      },
      ctx,
    );
    const body = openai.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    const content = (body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: "https://x/y.png" } });
  });
});
