/**
 * Codec round-trip tests (M0/M1, TC-018).
 *
 * Validates A -> IR -> A (lossless round trip) and the pure request/response
 * codecs for both protocols before exercising the full translate() pipeline.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter } from "../src/codecs/anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../src/codecs/protocol-adapter.js";
import { anthropicDefaultProfile } from "../src/codecs/anthropic-messages/index.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);
const openai = createOpenAiChatAdapter();

const anthropicTextRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  system: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
    },
    { role: "user", content: "Tell me about planets." },
  ],
};

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

describe("Anthropic Messages codec", () => {
  it("round-trips a text request to canonical and back (lossless)", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(anthropicTextRequest, ctx);
    expect(canonical.model).toBe("claude-sonnet-4-5");
    expect(canonical.system?.[0]).toMatchObject({ type: "text", text: "You are a helpful assistant." });
    expect(canonical.messages).toHaveLength(3);
    expect(canonical.messages[1]).toMatchObject({ role: "assistant" });

    const rendered = anthropic.request.renderRequest(canonical, false, ctx);
    expect(rendered).toEqual(anthropicTextRequest);
  });

  it("parses tool_use and tool_result blocks", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling echo." },
              { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "hi" },
            ],
          },
        ],
      },
      ctx,
    );
    const assistant = canonical.messages[0].content;
    expect(assistant[1]).toMatchObject({
      type: "tool_call",
      id: "toolu_1",
      name: "echo",
      argumentsText: '{"text":"hi"}',
    });
    const user = canonical.messages[1].content;
    expect(user[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "toolu_1",
    });
    expect((user[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("parses thinking and redacted_thinking blocks opaquely", () => {
    const ctx = newCodecContext();
    const canonical = anthropic.request.parseRequest(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "visible reasoning", signature: "sig-abc" },
              { type: "text", text: "Answer" },
            ],
          },
        ],
      },
      ctx,
    );
    expect(canonical.messages[0].content[0]).toMatchObject({
      type: "reasoning",
      text: "visible reasoning",
      signature: "sig-abc",
    });
  });

  it("throws on unknown tool_choice type", () => {
    const ctx = newCodecContext();
    expect(() =>
      anthropic.request.parseRequest(
        {
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          tool_choice: { type: "bogus" },
        },
        ctx,
      ),
    ).toThrow(/tool_choice/);
  });
});

describe("OpenAI Chat codec", () => {
  it("round-trips a text request to canonical and back (lossless)", () => {
    const ctx = newCodecContext();
    const canonical = openai.request.parseRequest(openaiTextRequest, ctx);
    expect(canonical.system?.[0]).toMatchObject({ type: "text", text: "You are a helpful assistant." });
    expect(canonical.messages).toHaveLength(3);

    const rendered = openai.request.renderRequest(canonical, false, ctx);
    expect(rendered).toEqual(openaiTextRequest);
  });

  it("round-trips tool_calls and tool messages", () => {
    const ctx = newCodecContext();
    const req = {
      model: "gpt-4o",
      stream: false,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "hi" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo text",
            parameters: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      ],
    };
    const canonical = openai.request.parseRequest(req, ctx);
    expect(canonical.tools?.[0]).toMatchObject({
      name: "echo",
      description: "Echo text",
    });
    expect(canonical.messages[0].content[0]).toMatchObject({
      type: "tool_call",
      id: "call_1",
      name: "echo",
    });
    expect(canonical.messages[1].content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_1",
    });

    const rendered = openai.request.renderRequest(canonical, false, ctx);
    expect(rendered).toEqual(req);
  });

  it("warns when a reasoning extension is present but profile lacks the field", () => {
    const ctx = newCodecContext();
    openai.request.parseRequest(
      {
        model: "gpt-4o",
        messages: [
          { role: "assistant", content: "hi", reasoning_content: "secret chain" },
        ],
      },
      ctx,
    );
    const reasoningWarnings = ctx.warnings.filter(
      (w) => w.code === "unmapped_reasoning",
    );
    expect(reasoningWarnings.length).toBeGreaterThan(0);
  });
});

describe("OpenAI Chat -> Anthropic Messages cross-codec", () => {
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
});

describe("Stop reason and usage mappings", () => {
  it("maps Anthropic stop_reason to canonical", () => {
    const ctx = newCodecContext();
    const parsed = anthropic.response.parseResponse(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Done" }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      ctx,
    );
    expect(parsed.finishReason).toBe("tool_call");
    expect(parsed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

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
});
