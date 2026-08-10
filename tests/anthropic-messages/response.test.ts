/**
 * Anthropic Messages response conversion tests.
 *
 * Source protocol: anthropic-messages. Renders canonical responses to the
 * OpenAI Chat target (reasoning/signature fields, stop-reason mapping) and
 * parses Anthropic stop reasons / usage into canonical.
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

  it("warns when a thinking signature has no declared opaque field (P1-2)", () => {
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
    openaiWithReasoning.response.renderResponse(canonical, ctx);
    const sig = ctx.warnings.find((w) => w.code === "thinking_signature_dropped");
    expect(sig).toBeTruthy();
    expect(sig!.fidelity).toBe("LOSSY");
  });

  it("preserves a thinking signature under a declared opaque field (P1-2)", () => {
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
    const body = openaiWithReasoning.response.renderResponse(canonical, ctx) as Record<string, unknown>;
    const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.thinking_signature).toBe("sig-1");
    expect(ctx.warnings.some((w) => w.code === "thinking_signature_dropped")).toBe(false);
  });
}

describe("Anthropic usage rendering (NONSTREAM-005 A-side)", () => {
  it("passes pure input_tokens straight to Anthropic (no double subtract, P1-1 fix)", () => {
    const ctx = newCodecContext();
    // canonical inputTokens is already pure (cache split at parse time), so
    // the Anthropic render must NOT subtract cache again.
    const body = anthropic.response.renderResponse(
      {
        id: "chatcmpl_1",
        model: "gpt-4o",
        content: [{ type: "text", text: "ok" }],
        finishReason: "end_turn",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 4,
        },
      },
      ctx,
    ) as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(12);
    expect((body.usage as Record<string, unknown>).cache_read_input_tokens).toBe(4);
    expect(ctx.warnings.some((w) => w.code === "cache_usage_approximation")).toBe(false);
  });

  it("keeps a small pure input_tokens without clamping (no split anymore)", () => {
    const ctx = newCodecContext();
    const body = anthropic.response.renderResponse(
      {
        id: "x",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 5 },
      },
      ctx,
    ) as Record<string, unknown>;
    // inputTokens is pure input; cache is reported separately, so 3 stays 3.
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(3);
    expect((body.usage as Record<string, unknown>).cache_read_input_tokens).toBe(5);
  });
});
describe("Anthropic stop_reason mapping", () => {
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
});
