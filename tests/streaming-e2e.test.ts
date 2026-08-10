/**
 * M2 end-to-end streaming tests through translate() (TC-002/005/010/012/013/
 * 014/015/016/020, SR-009 first-event latency).
 *
 * Every test goes through the public handler: source Request -> target SSE ->
 * canonical pipeline -> source SSE on Response.body.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";

const encoder = new TextEncoder();

function bytesStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectSSEFrames(
  body: ReadableStream<Uint8Array> | null,
): Promise<SSEFrame[]> {
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

async function collectText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  const reader = body!.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value, { stream: true });
  }
  return text;
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

/** Collect OpenAI data payloads (skipping [DONE]) from a translated stream. */
async function collectOpenAiChunks(
  frames: SSEFrame[],
): Promise<Array<Record<string, unknown>>> {
  return frames
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as Record<string, unknown>);
}

const anthropicTextStream =
  anthropicFrame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: {} } }) +
  anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " from" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Claude" } }) +
  anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 8, output_tokens: 5 } }) +
  anthropicFrame("message_stop", { type: "message_stop" });

const openaiTextStream =
  openaiFrame({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " from" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " GPT" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } }) +
  openaiFrame("[DONE]");

function openaiChatStreamRequest(): Request {
  return new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function anthropicMessagesStreamRequest(): Request {
  return new Request("https://api.openai.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}


{
  it("delivers the first translated event before the second upstream event (SR-009)", async () => {
    const head =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "early" } });
    const tail =
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " late" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_stop", { type: "message_stop" });
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(head));
        await new Promise((r) => setTimeout(r, 250));
        controller.enqueue(encoder.encode(tail));
        controller.close();
      },
    });
    const fetch = (async () =>
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = openaiChatStreamRequest();
    const t0 = Date.now();
    const response = await forward(request);
    const reader = response.body!.getReader();
    let buffer = "";
    let earlyElapsed = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      if (earlyElapsed < 0 && buffer.includes("early")) {
        earlyElapsed = Date.now() - t0;
      }
    }
    // The early text must already be visible before the 250ms pause ended.
    expect(earlyElapsed).toBeGreaterThanOrEqual(0);
    expect(earlyElapsed).toBeLessThan(200);
    expect(buffer).toContain("early");
    expect(buffer).toContain(" late");
  });

  it("injects an Anthropic ping while the upstream is idle (GAP-013)", async () => {
    // OpenAI upstream starts and then stalls (like long thinking); with the
    // Anthropic source the client must receive a keepalive ping during the
    // stall, before any further upstream data.
    const head = openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    const tail = openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "late" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openaiFrame("[DONE]");
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(head));
        await new Promise((r) => setTimeout(r, 150));
        controller.enqueue(encoder.encode(tail));
        controller.close();
      },
    });
    const fetch = (async () =>
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      keepAliveIntervalMs: 30,
    });
    const response = await forward(anthropicMessagesStreamRequest());
    const reader = response.body!.getReader();
    let buffer = "";
    let sawPing = false;
    let pingElapsed = -1;
    const t0 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      if (!sawPing && buffer.includes('event: ping')) {
        sawPing = true;
        pingElapsed = Date.now() - t0;
      }
    }
    // ping must arrive during the 150ms stall, before the tail (late text).
    expect(sawPing).toBe(true);
    expect(pingElapsed).toBeGreaterThanOrEqual(0);
    expect(pingElapsed).toBeLessThan(140);
    expect(buffer).toContain('text":"late"');
  });

  it("survives byte-level fragmentation end to end (TC-016)", async () => {
    const fetch = (async () => {
      const bytes = encoder.encode(anthropicTextStream);
      const fragmented = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) {
            controller.enqueue(bytes.subarray(i, i + 7));
          }
          controller.close();
        },
      });
      return new Response(fragmented, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest());
    const frames = await collectSSEFrames(response.body);
    const chunks = await collectOpenAiChunks(frames);
    const content = chunks
      .filter((c) => typeof (c.choices as Array<Record<string, unknown>>)[0]?.delta?.content === "string")
      .map((c) => ((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).content as string)
      .join("");
    expect(content).toBe("Hello from Claude");
    expect(frames[frames.length - 1].data).toBe("[DONE]");
  });
}

{
  it("propagates body cancellation to the upstream stream", async () => {
    let upstreamCancelled = false;
    const firstChunk = anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk));
        // never close; a real upstream would keep streaming
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const fetch = (async () =>
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(upstreamCancelled).toBe(true);
  });

  it("propagates an AbortSignal to the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      upstreamSignal = req.signal;
      return new Response(bytesStream(openaiTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const controller = new AbortController();
    const request = openaiChatStreamRequest();
    const requestWithSignal = new Request(request, { signal: controller.signal });
    const response = await forward(requestWithSignal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });
}
