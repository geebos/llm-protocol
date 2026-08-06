/**
 * M6 hardening tests (NFR-004/006, NFR-002 baseline).
 *
 * Body size limit, upstream timeout, malformed input tolerance (including
 * half-closed upstream streams), and a loose performance baseline that guards
 * against gross regressions without being flaky.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { TranslationError } from "../src/errors.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";

const encoder = new TextEncoder();

function openaiChatRequest(body: unknown, url = "https://api.anthropic.com/v1/chat/completions"): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function anthropicJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "c",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("NFR-006 body size limit", () => {
  it("rejects oversized request bodies with a validation error", async () => {
    const fetch = (async () => anthropicJsonResponse()) as typeof fetch;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      maxBodyBytes: 16,
    });
    const request = openaiChatRequest({
      model: "m",
      messages: [{ role: "user", content: "this payload is way bigger than 16 bytes" }],
    });
    const err = await forward(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("validation");
    expect((err as TranslationError).message).toMatch(/limit/);
  });

  it("accepts bodies within the limit", async () => {
    const fetch = (async () => anthropicJsonResponse()) as typeof fetch;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      maxBodyBytes: 1024,
    });
    const response = await forward(openaiChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    expect(response.status).toBe(200);
  });
});

describe("NFR-004 malformed input", () => {
  it("rejects a non-JSON request body with a validation error", async () => {
    const fetch = (async () => anthropicJsonResponse()) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      body: "this is not json {",
    });
    const err = await forward(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("validation");
  });

  it("tolerates a half-closed upstream stream and still ends cleanly", async () => {
    // Upstream writes one delta then closes without message_stop.
    const partial =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}\n\n';
    const fetch = (async () =>
      new Response(bytesStream(partial), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatRequest({ model: "m", stream: true, messages: [] }));
    const frames = await collectFrames(response.body);
    const chunks = frames.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data));
    const text = chunks
      .filter((c) => typeof c.choices?.[0]?.delta?.content === "string")
      .map((c) => c.choices[0].delta.content)
      .join("");
    expect(text).toBe("partial answer");
    // renderer's flush emits a safe terminal + [DONE]; no uncaught error
    expect(frames[frames.length - 1].data).toBe("[DONE]");
  });

  it("converts malformed SSE JSON into an error chunk, not a crash", async () => {
    const garbage = "data: {not json\n\n";
    const fetch = (async () =>
      new Response(bytesStream(garbage), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatRequest({ model: "m", stream: true, messages: [] }));
    const frames = await collectFrames(response.body);
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe("NFR-006 upstream timeout", () => {
  it("raises a timeout error when the upstream hangs", async () => {
    // Mock that honors the abort signal: never resolves until aborted.
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), 500);
        req.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(req.signal.reason);
        });
      });
      return anthropicJsonResponse();
    }) as typeof fetch;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      timeoutMs: 50,
    });
    const err = await forward(openaiChatRequest({ model: "m", messages: [] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("timeout");
  });

  it("does not time out when the upstream responds in time", async () => {
    const fetch = (async () => anthropicJsonResponse()) as typeof fetch;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      timeoutMs: 5000,
    });
    const response = await forward(openaiChatRequest({ model: "m", messages: [] }));
    expect(response.status).toBe(200);
  });
});

describe("NFR-002 performance baseline (loose guard)", () => {
  it("translates a non-streaming request well under 50ms p95 locally", async () => {
    const fetch = (async () => anthropicJsonResponse()) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const mkRequest = () =>
      openaiChatRequest({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello".repeat(200) },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "Tell me more.".repeat(200) },
        ],
      });
    const timings: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const response = await forward(mkRequest());
      await response.arrayBuffer();
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)];
    // NFR-002 targets 5ms p95; CI noise allowed, so guard at 50ms to catch
    // gross regressions without flakiness.
    expect(p95).toBeLessThan(50);
  });

  it("streams the first event quickly (SR-009 baseline)", async () => {
    const head =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n';
    const fetch = (async () =>
      new Response(bytesStream(head), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatRequest({ model: "m", stream: true, messages: [] }));
    const t0 = performance.now();
    const reader = response.body!.getReader();
    await reader.read();
    const elapsed = performance.now() - t0;
    reader.releaseLock();
    expect(elapsed).toBeLessThan(50);
  });
});

function bytesStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
}

async function collectFrames(body: ReadableStream<Uint8Array> | null): Promise<SSEFrame[]> {
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
