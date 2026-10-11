/**
 * Debug SSE capture (opt-in): raw upstream and raw client SSE retention.
 */
import { describe, expect, it } from "vitest";
import { translate } from "./support/request-translate.js";
import { createSSEParser } from "../src/streams/index.js";
import type { DebugSseCapture, PrivacyRecognizer } from "../src/index.js";

const encoder = new TextEncoder();

function bytesStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.pipeThrough(createSSEParser()).getReader();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value.data);
  }
  return parts.join("\n");
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const anthropicStream =
  anthropicFrame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      usage: {},
    },
  }) +
  anthropicFrame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  anthropicFrame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "call <private_placeholder_phone_1> now" },
  }) +
  anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  anthropicFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 1, output_tokens: 1 },
  }) +
  anthropicFrame("message_stop", { type: "message_stop" });

function openaiStreamRequest(): Request {
  return new Request("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "call 13800138000" }],
    }),
  });
}

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf("13800138000");
      while (idx !== -1) {
        out.push({ start: idx, end: idx + 11, type: "phone" });
        idx = text.indexOf("13800138000", idx + 1);
      }
      return out;
    },
  };
}

const fetchUpstream = (async () =>
  new Response(bytesStream(anthropicStream), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

function waitCapture(): { promise: Promise<DebugSseCapture>; onComplete: (c: DebugSseCapture) => void } {
  let resolve: (c: DebugSseCapture) => void;
  const promise = new Promise<DebugSseCapture>((r) => {
    resolve = r;
  });
  return { promise, onComplete: (c) => resolve(c) };
}

describe("debug SSE capture", () => {
  it("captures the raw upstream SSE", async () => {
    const cap = waitCapture();
    const chunks: { side: string; sequence: number }[] = [];
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchUpstream,
      debug: {
        capture: "upstream-sse",
        onChunk: (c) => chunks.push({ side: c.side, sequence: c.sequence }),
        onComplete: cap.onComplete,
      },
    });
    const response = await forward(openaiStreamRequest());
    await drain(response.body);
    const capture = await cap.promise;
    expect(capture.upstream).toBe(anthropicStream);
    expect(capture.client).toBeUndefined();
    expect(capture.upstreamBytes).toBe(encoder.encode(anthropicStream).byteLength);
    expect(chunks.every((c) => c.side === "upstream")).toBe(true);
  });

  it("captures the raw client SSE including restored values", async () => {
    const cap = waitCapture();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchUpstream,
      privacy: { recognizers: [phoneRecognizer()] },
      debug: { capture: "client-sse", onComplete: cap.onComplete },
    });
    const response = await forward(openaiStreamRequest());
    await drain(response.body);
    const capture = await cap.promise;
    // The restored original only exists on the client side.
    expect(capture.client).toContain("13800138000");
    expect(capture.client).not.toContain("<private_placeholder_phone_1>");
    expect(capture.upstream).toBeUndefined();
  });

  it("captures both sides via onComplete", async () => {
    const cap = waitCapture();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchUpstream,
      privacy: { recognizers: [phoneRecognizer()] },
      debug: { capture: "both", onComplete: cap.onComplete },
    });
    const response = await forward(openaiStreamRequest());
    await drain(response.body);
    const capture = await cap.promise;
    // Upstream keeps the placeholder, client has the restored value.
    expect(capture.upstream).toContain("<private_placeholder_phone_1>");
    expect(capture.client).toContain("13800138000");
  });

  it("stops retaining after maxBytes but keeps draining", async () => {
    const cap = waitCapture();
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchUpstream,
      debug: { capture: "upstream-sse", maxBytes: 32, onComplete: cap.onComplete },
    });
    const response = await forward(openaiStreamRequest());
    // Full client stream must still be delivered despite the capture cap.
    const clientText = await drain(response.body);
    expect(clientText).toContain("call");
    const capture = await cap.promise;
    expect(capture.truncated).toBe(true);
    expect((capture.upstream ?? "").length).toBeLessThanOrEqual(32);
  });

  it("captures on the same-protocol passthrough path", async () => {
    const cap = waitCapture();
    const forward = translate({
      from: "anthropic-messages",
      to: "anthropic-messages",
      fetch: fetchUpstream,
      debug: { capture: "upstream-sse", onComplete: cap.onComplete },
    });
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", stream: true, messages: [] }),
    });
    const response = await forward(request);
    await drain(response.body);
    const capture = await cap.promise;
    expect(capture.upstream).toBe(anthropicStream);
  });
});
