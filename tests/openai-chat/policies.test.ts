/**
 * M4 thinking/reasoning policy tests, OpenAI Chat source -> Anthropic target
 * (TH-004, TC-009).
 *
 * When the OpenAI Chat target cannot represent reasoning: reject /
 * drop_with_warning (default) / provider_metadata. Nothing may be silently
 * dropped; every decision lands in the TranslationReport.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import { TranslationError } from "../../src/errors.js";
import { createSSEParser, type SSEFrame } from "../../src/streams/index.js";
import type { TranslationPolicies } from "../../src/ir/policies.js";
import type { TranslationTrace } from "../../src/pipeline/types.js";

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
