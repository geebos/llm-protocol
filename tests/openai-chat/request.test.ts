/**
 * OpenAI Chat request conversion tests.
 *
 * Source protocol: openai-chat. Renders canonical requests to the Anthropic
 * Messages target (tools, tool choice, generation options, strict-flag
 * lossiness, thinking-config warnings, parallel_tool_calls, reasoning_effort,
 * base64-image lossiness) and cross-codec semantic preservation.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter, anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CanonicalRequest } from "../../src/ir/types.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

const openaiTextRequest = {
  model: "gpt-4o",
  stream: false,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "Tell me about planets." },
  ],
};

{
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
    canonical.thinking = { mode: "enabled", budgetTokens: 2000 };
    const body = openai.request.renderRequest(canonical, false, ctx);
    expect(body).toBeTruthy();
    expect(ctx.warnings.some((w) => w.code === "thinking_dropped")).toBe(true);
  });
}

{
  it("converts request IR between protocols preserving semantics", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(openaiTextRequest, ctx);
    const anthropicBody = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;

    expect(anthropicBody.model).toBe("gpt-4o");
    expect(anthropicBody.max_tokens).toBe(1024);
    expect(anthropicBody.system).toBe("You are a helpful assistant.");
    const msgs = anthropicBody.messages as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello");
  });
}

{
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


}

{
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
}
describe("images and base64 lossy warning", () => {
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
  })
});
