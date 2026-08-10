/**
 * OpenAI Chat codec tests (M0/M1, TC-018).
 *
 * Source protocol: openai-chat. Round-trip C -> IR -> C (lossless), tool_calls
 * and tool messages, and the unmapped-reasoning warning branch.
 */
import { describe, expect, it } from "vitest";
import { createOpenAiChatAdapter } from "../../src/codecs/openai-chat/index.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";

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
}
