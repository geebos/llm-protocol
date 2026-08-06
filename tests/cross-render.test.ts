/**
 * Cross-protocol render coverage (M1).
 *
 * Exercises the render paths of both request/response codecs in both
 * directions, including tools, thinking, images, generation options and the
 * lossy-warning branches.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter, anthropicDefaultProfile } from "../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../src/codecs/protocol-adapter.js";
import type { CanonicalRequest, ContentPart } from "../src/ir/types.js";
import type { CanonicalResponse } from "../src/ir/response.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

describe("OpenAI request -> Anthropic request render", () => {
  const openaiReq = {
    model: "gpt-4o",
    stream: false,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "echo", arguments: '{"x":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "echoed" },
    ],
    tools: [
      { type: "function", function: { name: "echo", parameters: { type: "object" }, strict: true } },
    ],
    tool_choice: { type: "function", function: { name: "echo" } },
    temperature: 0.5,
    top_p: 0.9,
    stop: ["\n"],
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    seed: 42,
  };

  it("renders tools, tool choice, generation options and multi-turn tool flow", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(openaiReq, ctx);
    const body = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;

    expect(body.model).toBe("gpt-4o");
    expect(body.system).toBe("Be brief.");
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(["\n"]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "echo" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "echo", input_schema: { type: "object" } });

    const msgs = body.messages as Array<Record<string, unknown>>;
    // system goes to top-level `system`; messages hold user/assistant/tool result
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect((msgs[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "echo",
      input: { x: 1 },
    });
    expect(msgs[2]).toMatchObject({ role: "user" });
    const toolResult = (msgs[2].content as Array<Record<string, unknown>>)[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.tool_use_id).toBe("call_1");

    // strict tool flag is LOSSY on the Anthropic side
    expect(ctx.warnings.some((w) => w.code === "tool_strict")).toBe(true);
  });

  it("warns when thinking config is requested but target lacks thinking", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
      ctx,
    );
    canonical.thinking = { enabled: true, budgetTokens: 2000 };
    const body = openai.request.renderRequest(canonical, false, ctx);
    expect(body).toBeTruthy();
    expect(ctx.warnings.some((w) => w.code === "thinking_dropped")).toBe(true);
  });
});

describe("Anthropic request -> OpenAI request render", () => {
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
});

describe("OpenAI response -> Anthropic response render", () => {
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
});

describe("Anthropic response -> OpenAI response render", () => {
  const canonical: CanonicalResponse = {
    id: "msg_1",
    model: "claude-sonnet-4-5",
    content: [
      { type: "reasoning", text: "chain", signature: "sig-1" } as ContentPart,
      { type: "text", text: "Answer" },
    ],
    finishReason: "end_turn",
    usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
  };

  it("renders reasoning blocks into the declared reasoning field", () => {
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
    const body = openaiWithReasoning.response.renderResponse(canonical, ctx) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.reasoning_content).toBe("chain");
    expect(message.content).toBe("Answer");
    expect((body.usage as Record<string, unknown>).prompt_tokens).toBe(8);
  });
});

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

  it("emits a LOSSY warning for base64 images on OpenAI target", () => {
    const ctx = newCodecContext();
    const canonical: CanonicalRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
          ],
        },
      ],
    };
    const body = openai.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    expect(body.messages).toEqual([]);
    expect(ctx.warnings.some((w) => w.code === "image_lossy")).toBe(true);
  });
});
