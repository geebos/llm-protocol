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

describe("openai-chat -> anthropic-messages streaming (TC-020, TC-002)", () => {
  it("executes the target protocol and returns OpenAI SSE to the client", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      capturedUrl = req.url;
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(bytesStream(anthropicTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest());

    // TC-020: execute saw the target protocol
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.max_tokens).toBe(1024);

    // client receives source-protocol SSE
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await collectSSEFrames(response.body);
    const chunks = await collectOpenAiChunks(frames);

    expect(chunks[0].object).toBe("chat.completion.chunk");
    const content = chunks
      .filter((c) => typeof (c.choices as Array<Record<string, unknown>>)[0]?.delta?.content === "string")
      .map((c) => ((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).content as string)
      .join("");
    expect(content).toBe("Hello from Claude");

    const lastChunk = chunks[chunks.length - 1];
    expect(((lastChunk.choices as Array<Record<string, unknown>>)[0]).finish_reason).toBe("stop");
    expect((lastChunk.usage as Record<string, unknown>).prompt_tokens).toBe(8);
    expect((lastChunk.usage as Record<string, unknown>).completion_tokens).toBe(5);
    expect(frames[frames.length - 1].data).toBe("[DONE]");
  });

  it("streams tool_use back as OpenAI tool_calls with valid JSON (TC-005)", async () => {
    const toolStream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking weather." } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city"' } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"Paris"}' } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 1 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const fetch = (async () =>
      new Response(bytesStream(toolStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest());
    const frames = await collectSSEFrames(response.body);
    const chunks = await collectOpenAiChunks(frames);

    const toolChunks = chunks.filter((c) => (c.choices as Array<Record<string, unknown>>)[0]?.delta?.tool_calls);
    const start = (toolChunks[0].choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0] as Record<string, unknown>;
    expect(start.id).toBe("toolu_1");
    expect((start.function as Record<string, unknown>).name).toBe("get_weather");

    const args = toolChunks
      .map((c) => (((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>)[0])
      .map((tc) => (tc.function as Record<string, unknown>).arguments as string)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Paris" }); // SR-003
    expect(((chunks[chunks.length - 1].choices as Array<Record<string, unknown>>)[0]).finish_reason).toBe("tool_calls");
  });

  it("keeps reasoning deltas when the openai profile declares a reasoning field (TC-010, TH-006)", async () => {
    const thinkingStream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig-0" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 1 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const fetch = (async () =>
      new Response(bytesStream(thinkingStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const reasoningProfile = {
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
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      profiles: { "openai-chat": reasoningProfile },
    });
    const response = await forward(openaiChatStreamRequest());
    const frames = await collectSSEFrames(response.body);
    const chunks = await collectOpenAiChunks(frames);

    const reasoning = chunks
      .filter((c) => typeof (c.choices as Array<Record<string, unknown>>)[0]?.delta?.reasoning_content === "string")
      .map((c) => ((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).reasoning_content as string)
      .join("");
    expect(reasoning).toBe("Let me think.");

    const text = chunks
      .filter((c) => typeof (c.choices as Array<Record<string, unknown>>)[0]?.delta?.content === "string")
      .map((c) => ((c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).content as string)
      .join("");
    expect(text).toBe("Answer.");
  });

  it("reverse-translates an in-stream Anthropic error into an OpenAI error chunk (TC-014, SR-006)", async () => {
    const errorStream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", content: [], role: "assistant", type: "message", model: "c", stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }) +
      anthropicFrame("error", { type: "error", error: { type: "api_error", message: "upstream exploded" } });

    const fetch = (async () =>
      new Response(bytesStream(errorStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest());
    const frames = await collectSSEFrames(response.body);
    const chunks = await collectOpenAiChunks(frames);
    const errorChunk = chunks.find((c) => c.error);
    expect(errorChunk).toBeTruthy();
    expect((errorChunk!.error as Record<string, unknown>).message).toBe("upstream exploded");
    expect(frames[frames.length - 1].data).toBe("[DONE]");
  });
});

describe("anthropic-messages -> openai-chat streaming", () => {
  it("returns Anthropic SSE events to the client (TC-020)", async () => {
    const fetch = (async () =>
      new Response(bytesStream(openaiTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    const response = await forward(anthropicMessagesStreamRequest());
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
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    const response = await forward(anthropicMessagesStreamRequest());
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).type).toBe("invalid_request_error");
  });
});

describe("first-event latency and fragmentation (SR-009, TC-016)", () => {
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
});

describe("client cancellation (TC-015, SR-008)", () => {
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
});
