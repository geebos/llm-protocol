/**
 * M4 thinking/reasoning policy tests (TH-004, TC-009).
 *
 * Three strategies when the OpenAI Chat target cannot represent reasoning:
 * reject / drop_with_warning (default) / provider_metadata. Nothing may be
 * silently dropped; every decision lands in the TranslationReport.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { TranslationError } from "../src/errors.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";
import type { TranslationPolicies } from "../src/ir/policies.js";
import type { TranslationTrace } from "../src/pipeline/types.js";

const encoder = new TextEncoder();

function bytesStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collectSSEFrames(body: ReadableStream<Uint8Array> | null): Promise<SSEFrame[]> {
  if (!body) return [];
  const frames: SSEFrame[] = [];
  const reader = body.pipeThrough(createSSEParser()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(value);
  }
  return frames;
}

/** Anthropic-format request carrying a thinking config. */
function anthropicThinkingRequest(): Request {
  return new Request("https://api.openai.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: false,
      max_tokens: 2000,
      thinking: { type: "enabled", budget_tokens: 1000 },
      messages: [{ role: "user", content: "solve it" }],
    }),
  });
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
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      trace: (t) => traces.push(t),
    });

    await forward(anthropicThinkingRequest());
    expect(captured.thinking).toBeUndefined();
    expect(traces[0].warnings.some((w) => w.code === "thinking_dropped")).toBe(true);
  });

  it("reject policy throws a typed unsupported error", async () => {
    const fetch = (async () => openAiSuccessResponse()) as typeof fetch;
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      policies: { reasoning: "reject" } as TranslationPolicies,
    });
    const err = await forward(anthropicThinkingRequest()).catch((e: unknown) => e);
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
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      policies: { reasoning: "provider_metadata" } as TranslationPolicies,
      trace: (t) => traces.push(t),
    });

    await forward(anthropicThinkingRequest());
    expect(captured.metadata).toEqual({
      llm_protocol_thinking: { mode: "enabled", budgetTokens: 1000 },
    });
    expect(traces[0].warnings.some((w) => w.code === "thinking_provider_metadata")).toBe(true);
  });
});

describe("response-side reasoning (source = openai-chat)", () => {
  const anthropicThinkingResponse =
    '{"id":"msg_1","type":"message","role":"assistant","model":"claude",' +
    '"content":[{"type":"thinking","thinking":"hidden chain","signature":"sig-1"},' +
    '{"type":"text","text":"answer"}],"stop_reason":"end_turn",' +
    '"usage":{"input_tokens":5,"output_tokens":3}}';

  it("provider_metadata policy renders reasoning_content on the non-streaming response", async () => {
    const fetch = (async () =>
      new Response(anthropicThinkingResponse, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const traces: TranslationTrace[] = [];
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      policies: { reasoning: "provider_metadata" } as TranslationPolicies,
      trace: (t) => traces.push(t),
    });

    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    const body = (await response.json()) as Record<string, unknown>;
    const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.reasoning_content).toBe("hidden chain");
    expect((message.content as string | null)).toBe("answer");
    expect(traces[0].warnings.some((w) => w.code === "reasoning_provider_metadata")).toBe(true);
  });

  it("default drop_with_warning drops reasoning and reports", async () => {
    const fetch = (async () =>
      new Response(anthropicThinkingResponse, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const traces: TranslationTrace[] = [];
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      trace: (t) => traces.push(t),
    });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    const body = (await response.json()) as Record<string, unknown>;
    const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.reasoning_content).toBeUndefined();
    expect(traces[0].warnings.some((w) => w.code === "reasoning_dropped")).toBe(true);
  });

  it("provider_metadata policy streams reasoning_content (TH-004 streaming)", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "s" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "chain part" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });
    const fetch = (async () =>
      new Response(bytesStream(stream), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const traces: TranslationTrace[] = [];
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      policies: { reasoning: "provider_metadata" } as TranslationPolicies,
      trace: (t) => traces.push(t),
    });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    const frames = await collectSSEFrames(response.body);
    const chunks = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>);
    const reasoning = chunks
      .filter((c) => typeof (c.choices as Array<Record<string, unknown>>)[0]?.delta?.reasoning_content === "string")
      .map((c) => ((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).reasoning_content as string)
      .join("");
    expect(reasoning).toBe("chain part");
    expect(traces[0].warnings.some((w) => w.code === "reasoning_provider_metadata")).toBe(true);
  });

  it("default drop_with_warning drops streamed reasoning and reports once", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "s" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " chain" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });
    const fetch = (async () =>
      new Response(bytesStream(stream), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const traces: TranslationTrace[] = [];
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      trace: (t) => traces.push(t),
    });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    const frames = await collectSSEFrames(response.body);
    const chunks = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>);
    // reasoning must not leak into the OpenAI stream
    expect(chunks.some((c) => (c.choices as Array<Record<string, unknown>>)[0]?.delta?.reasoning_content)).toBe(false);
    const drops = traces[0].warnings.filter((w) => w.code === "reasoning_dropped");
    expect(drops.length).toBe(1);
  });
});

describe("thinking opaque metadata round-trip (TH-001)", () => {
  it("keeps signature bytes intact through Anthropic request round-trip", async () => {
    // Signature is opaque: parse an Anthropic request with a thinking block and
    // re-render it, asserting the signature value survives byte-for-byte.
    const { createAnthropicAdapter } = await import("../src/codecs/anthropic-messages/index.js");
    const { newCodecContext } = await import("../src/codecs/protocol-adapter.js");
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
