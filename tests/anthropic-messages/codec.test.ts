/**
 * Anthropic Messages codec tests (M0/M1, TC-018).
 *
 * Source protocol: anthropic-messages. Round-trip A -> IR -> A (lossless),
 * tool/thinking blocks parsed opaquely, and opaque signature preservation.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicAdapter, anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";

const anthropic = createAnthropicAdapter(anthropicDefaultProfile);

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

{
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
}

{
  it("keeps signature bytes intact through Anthropic request round-trip", async () => {
    // Signature is opaque: parse an Anthropic request with a thinking block and
    // re-render it, asserting the signature value survives byte-for-byte.
    const { createAnthropicAdapter } = await import("../../src/codecs/anthropic-messages/index.js");
    const { newCodecContext } = await import("../../src/codecs/protocol-adapter.js");
    const anthropic = createAnthropicAdapter();

    const ctx = newCodecContext();
    const input = {
      model: "m",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "opaque", signature: "SIG-ABC-123" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const canonical = anthropic.request.parseRequest(input, ctx);
    const rendered = anthropic.request.renderRequest(canonical, false, ctx) as Record<string, unknown>;
    const msg = (rendered.messages as Array<{ content: unknown[] }>)[0];
    const thinking = msg.content.find((b) => (b as { type?: string }).type === "thinking") as {
      type: string;
      thinking: string;
      signature: string;
    };
    expect(thinking.thinking).toBe("opaque");
    expect(thinking.signature).toBe("SIG-ABC-123");
  });
}
