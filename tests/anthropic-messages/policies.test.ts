/**
 * M4 thinking/reasoning policy tests, Anthropic Messages source -> OpenAI
 * Chat target (TH-004, TC-009) plus Anthropic thinking metadata fidelity
 * (TH-001).
 *
 * Three strategies when the OpenAI Chat target cannot represent reasoning:
 * reject / drop_with_warning (default) / provider_metadata. Nothing may be
 * silently dropped; every decision lands in the TranslationReport.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import { TranslationError } from "../../src/errors.js";
import type { TranslationPolicies } from "../../src/ir/policies.js";
import type { TranslationTrace } from "../../src/pipeline/types.js";

const TARGET_URL = "https://api.openai.com/v1/chat/completions";
const HEADERS = { authorization: "Bearer sk-key" };

/** Anthropic-format request options carrying a thinking config. */
function anthropicThinkingOptions(): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: TARGET_URL,
    headers: HEADERS,
    body: {
      model: "gpt-4o",
      stream: false,
      max_tokens: 2000,
      thinking: { type: "enabled", budget_tokens: 1000 },
      messages: [{ role: "user", content: "solve it" }],
    },
  };
}

function openAiSuccessResponse(): Response {
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

describe("request-side thinking config (target = openai-chat)", () => {
  it("default drop_with_warning: drops config and reports (TC-009)", async () => {
    let captured: Record<string, unknown> = {};
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      captured = (await req.json()) as Record<string, unknown>;
      return openAiSuccessResponse();
    }) as typeof fetch;
    const traces: TranslationTrace[] = [];

    await translate.messages.chat({
      ...anthropicThinkingOptions(),
      fetch,
      trace: (t) => traces.push(t),
    });
    expect(captured.thinking).toBeUndefined();
    expect(traces[0].warnings.some((w) => w.code === "thinking_dropped")).toBe(true);
  });

  it("reject policy throws a typed unsupported error", async () => {
    const fetch = (async () => openAiSuccessResponse()) as typeof fetch;
    const err = await translate.messages.chat({
      ...anthropicThinkingOptions(),
      fetch,
      policies: { reasoning: "reject" } as TranslationPolicies,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("unsupported");
  });

  it("provider_metadata policy preserves the config in request metadata", async () => {
    let captured: Record<string, unknown> = {};
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      captured = (await req.json()) as Record<string, unknown>;
      return openAiSuccessResponse();
    }) as typeof fetch;
    const traces: TranslationTrace[] = [];

    await translate.messages.chat({
      ...anthropicThinkingOptions(),
      fetch,
      policies: { reasoning: "provider_metadata" } as TranslationPolicies,
      trace: (t) => traces.push(t),
    });
    expect(captured.metadata).toEqual({
      llm_protocol_thinking: { mode: "enabled", budgetTokens: 1000 },
    });
    expect(traces[0].warnings.some((w) => w.code === "thinking_provider_metadata")).toBe(true);
  });
});

describe("thinking opaque metadata round-trip (TH-001)", () => {
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
});
