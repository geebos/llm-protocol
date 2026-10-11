/**
 * M2 end-to-end streaming tests through translate(), Anthropic Messages ->
 * OpenAI Chat direction (TC-002/020/023, GAP-013 keepalive).
 *
 * Every test goes through the public handler: source Request -> target SSE ->
 * canonical pipeline -> source SSE on Response.body.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import { createSSEParser, type SSEFrame } from "../../src/streams/index.js";

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

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

const openaiTextStream =
  openaiFrame({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " from" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " GPT" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } }) +
  openaiFrame("[DONE]");

function anthropicMessagesOptions(): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { authorization: "Bearer sk-key" },
    body: {
      model: "gpt-4o",
      stream: true,
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    },
  };
}

describe("anthropic-messages -> openai-chat streaming", () => {
  it("returns Anthropic SSE events to the client (TC-020)", async () => {
    const fetch = (async () =>
      new Response(bytesStream(openaiTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const response = await translate.messages.chat({ ...anthropicMessagesOptions(), fetch });
    const frames = await collectSSEFrames(response.body);
    const events = frames.map((f) => f.event);

    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const messageStart = JSON.parse(frames[0].data);
    expect(messageStart.message.role).toBe("assistant");
    const texts = frames
      .filter((f) => f.event === "content_block_delta")
      .map((f) => JSON.parse(f.data).delta.text as string);
    expect(texts.join("")).toBe("Hello from GPT");
    const messageDelta = JSON.parse(frames[frames.length - 2].data);
    expect(messageDelta.delta.stop_reason).toBe("end_turn");
    expect(messageDelta.usage.input_tokens).toBe(8);
    expect(messageDelta.usage.output_tokens).toBe(5);
  });

  it("converts an upstream HTTP error to an Anthropic error response (TC-023)", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "bad model", code: "bad" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const response = await translate.messages.chat({ ...anthropicMessagesOptions(), fetch });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).type).toBe("invalid_request_error");
  });
});

describe("keepalive pings (GAP-013)", () => {
  it("injects an Anthropic ping while the upstream is idle", async () => {
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

    const response = await translate.messages.chat({
      ...anthropicMessagesOptions(),
      fetch,
      keepAliveIntervalMs: 30,
    });
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
});
