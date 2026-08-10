/**
 * OpenAI Chat -> Anthropic Messages end-to-end tests through translate().
 *
 * Source protocol: openai-chat. Streaming (TC-020/TC-005/TC-010/TC-014),
 * parallel tool calls (TC-008), multi-turn tool re-injection (TC-006),
 * synthesized tool ids (TR-002), reasoning policy handling, upstream error
 * reverse translation, and official SDK consumption of the translated
 * OpenAI stream.
 */
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { translate } from "../../src/pipeline/translate.js";
import { createSSEParser, type SSEFrame } from "../../src/streams/index.js";
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

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
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

async function collectOpenAiChunks(frames: SSEFrame[]): Promise<Array<Record<string, unknown>>> {
  return frames.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data) as Record<string, unknown>);
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

const openaiTextResponse = {
  id: "chatcmpl_456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello from GPT" }, finish_reason: "stop", logprobs: null },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

const anthropicTextResponse = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null;
}

function fakeFetch(
  handler: (req: Request) => Response | Promise<Response>,
): { fetch: typeof fetch; lastRequest: () => CapturedRequest } {
  let captured: CapturedRequest | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = { url: req.url, headers: new Headers(req.headers), body: await req.json(), signal: req.signal ?? null };
    return handler(req);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    lastRequest: () => {
      if (!captured) throw new Error("fetch was never called");
      return captured;
    },
  };
}

function openaiChatStreamRequest(messages: unknown[] = [{ role: "user", content: "hi" }]): Request {
  return new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages }),
  });
}

function openaiChatNonStreamRequest(messages: unknown[]): Request {
  return new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages }),
  });
}

function anthropicToolStream(...blocks: Array<{ id: string; name: string }>): string {
  let s = anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } });
  blocks.forEach((b, i) => {
    s += anthropicFrame("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
    s += anthropicFrame("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: `{"arg":${i}}` } });
    s += anthropicFrame("content_block_stop", { type: "content_block_stop", index: i });
  });
  s += anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
  s += anthropicFrame("message_stop", { type: "message_stop" });
  return s;
}

/** NONSTREAM-001/002 style: capture the converted target body. */
async function translateCapturing(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = (await req.json()) as Record<string, unknown>;
    return fetchImpl(req);
  }) as typeof fetch;
  const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
  await forward(
    new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false, ...body }),
    }),
  );
  return captured;
}

function openAiJsonResponse(): Response {
  return jsonResponse(openaiTextResponse);
}

{
  it("rewrites URL path, headers and body to the target protocol (TC-019, 9.13#1)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-secret",
        "content-type": "application/json",
        "x-tracing": "should-be-stripped",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    const response = await forward(request);
    const captured = lastRequest();

    // 9.13#2: origin preserved, pathname converted
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");

    // 9.13#3: credential value moved to x-api-key
    expect(captured.headers.get("x-api-key")).toBe("sk-ant-secret");
    expect(captured.headers.get("anthropic-version")).toBe("2023-06-01");
    // 9.13#5: no source auth header leaked, hop-by-hop stripped
    expect(captured.headers.get("authorization")).toBeNull();
    expect(captured.headers.get("x-tracing")).toBeNull();
    expect(captured.headers.get("content-length")).toBeNull();

    // 9.13#7: body converted
    expect(captured.body).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    });

    // 9.13#8: response restored to from protocol
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "claude-sonnet-4-5",
    });
    const choice = (body.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message).toMatchObject({
      role: "assistant",
      content: "Hello from Claude",
    });
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(8);
    expect(usage.completion_tokens).toBe(4);
  });

  it("converts a tool call response into OpenAI tool_calls (TC-004)", async () => {
    const anthropicToolResponse = {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "I will check the weather." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    const { fetch } = fakeFetch(() => jsonResponse(anthropicToolResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }),
    });

    const response = await forward(request);
    const body = (await response.json()) as Record<string, unknown>;
    const message = ((body.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
    expect(message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect((body.choices as Array<Record<string, unknown>>)[0].finish_reason).toBe("tool_calls");
  });

  it("propagates a request body twice without reuse (FR-004 validation)", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await forward(request);
    await expect(forward(request)).rejects.toThrow(/consumed/);
  });

  it("rejects a mismatched source pathname with a typed validation error", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    await expect(forward(request)).rejects.toThrow(/does not match/);
  });
}

{
  it("reverse-translates OpenAI upstream error into Anthropic error shape", async () => {
    const upstreamError = {
      error: {
        message: "Incorrect API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    };
    const { fetch } = fakeFetch(() =>
      new Response(JSON.stringify(upstreamError), { status: 401 }),
    );
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer key" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    // OpenAI error envelope: { error: {...} } with no top-level type field
    expect((body.error as Record<string, unknown>).type).toBe("invalid_request_error");
    expect((body.error as Record<string, unknown>).message).toContain("Incorrect API key");
  });
}

{
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
}

{
  it("renders two tool_use blocks as distinct tool_calls without cross-wiring", async () => {
    const stream = anthropicToolStream(
      { id: "toolu_a", name: "get_weather" },
      { id: "toolu_b", name: "get_time" },
    );
    const fetch = (async () =>
      new Response(bytesStream(stream), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const response = await forward(openaiChatStreamRequest([{ role: "user", content: "weather and time" }]));
    const frames = await collectSSEFrames(response.body);
    const chunks = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>);
    const toolChunks = chunks.filter(
      (c) => (c.choices as Array<Record<string, unknown>>)[0]?.delta?.tool_calls,
    );

    // two separate tool_calls positions, ids/names stable, args not cross-wired
    const first = toolChunks.find((c) => (c.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].index === 0)!;
    const second = toolChunks.find((c) => (c.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].index === 1)!;
    expect((first.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].id).toBe("toolu_a");
    expect((first.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect((second.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].id).toBe("toolu_b");
    expect((second.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0].function.name).toBe("get_time");

    const argsByPos: Record<number, string> = {};
    for (const c of toolChunks) {
      const tc = (c.choices as Array<Record<string, unknown>>)[0].delta.tool_calls[0];
      argsByPos[tc.index as number] = (argsByPos[tc.index as number] ?? "") + (tc.function as Record<string, unknown>).arguments;
    }
    expect(JSON.parse(argsByPos[0])).toEqual({ arg: 0 });
    expect(JSON.parse(argsByPos[1])).toEqual({ arg: 1 });
    expect(((chunks[chunks.length - 1].choices as Array<Record<string, unknown>>)[0]).finish_reason).toBe("tool_calls");
  });
}

{
  it("round-trips a tool_use stream, then re-injects the tool_result for the next turn", async () => {
    // Turn 1: assistant calls get_weather via a streamed Anthropic tool_use.
    const toolStream = anthropicToolStream({ id: "toolu_1", name: "get_weather" });
    const turn1Fetch = (async () =>
      new Response(bytesStream(toolStream), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const forward1 = translate({ from: "openai-chat", to: "anthropic-messages", fetch: turn1Fetch });
    const resp1 = await forward1(openaiChatStreamRequest([{ role: "user", content: "Paris weather?" }]));
    const frames1 = await collectSSEFrames(resp1.body);

    // Client (an OpenAI SDK user) sees a tool_calls chunk.
    const chunks1 = frames1.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data));
    const toolChunk = chunks1.find((c) => (c.choices[0]?.delta?.tool_calls));
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("toolu_1");

    // Turn 2: client re-injects the result as an OpenAI role=tool message.
    let capturedTargetBody: Record<string, unknown> = {};
    const turn2Fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      capturedTargetBody = (await req.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: "c", content: [{ type: "text", text: "25C" }], stop_reason: "end_turn", usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const forward2 = translate({ from: "openai-chat", to: "anthropic-messages", fetch: turn2Fetch });

    const request2 = openaiChatNonStreamRequest([
      { role: "user", content: "Paris weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "sunny, 25C" },
    ]);
    const resp2 = await forward2(request2);

    // The Anthropic target received a tool_result block linked to the same id.
    const msgs = capturedTargetBody.messages as Array<{ role: string; content: unknown }>;
    const lastMsg = msgs[msgs.length - 1];
    const block = (lastMsg.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result");
    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "sunny, 25C",
    });

    const body2 = (await resp2.json()) as Record<string, unknown>;
    // resp2 is OpenAI protocol (from=openai-chat), so text lives in choices[0].message
    expect(((body2.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content).toBe("25C");
  });

  it("keeps is_error semantics when a tool result failed (TR-004)", async () => {
    let capturedTargetBody: Record<string, unknown> = {};
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      capturedTargetBody = (await req.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const request = openaiChatStreamRequest([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_9", type: "function", function: { name: "api", arguments: "{}" } }],
      },
      // OpenAI has no is_error; the failure is expressed by the caller wrapping
      // the tool content — the test asserts the message is passed through.
      { role: "tool", tool_call_id: "call_9", content: "ERROR: api unavailable" },
    ]);
    await forward(request);
    const msgs = capturedTargetBody.messages as Array<{ content: unknown }>;
    const block = (msgs[1].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call_9");
    expect(block.content).toContain("ERROR");
  });
}

{
  it("reports a synthesized tool_use id in the trace (Anthropic upstream)", async () => {
    // Anthropic tool_use without an id.
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "echo", input: {} } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }) +
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
    const response = await forward(openaiChatStreamRequest([{ role: "user", content: "go" }]));
    const frames = await collectSSEFrames(response.body);

    // synthesized id reached the client as toolu_0
    const chunks = frames.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data));
    const toolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("toolu_0");

    // ...and was reported
    const last = traces[traces.length - 1];
    expect(last.warnings.some((w) => w.code === "synthesized_tool_id")).toBe(true);
  });
}

{
  it("handles two sequential streaming calls with isolated block state", async () => {
    // First call: one tool; second call: text. Same translate() instance.
    let call = 0;
    const fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(bytesStream(anthropicToolStream({ id: "toolu_x", name: "get_weather" })), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const textStream =
        anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } }) +
        anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain answer" } }) +
        anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
        anthropicFrame("message_stop", { type: "message_stop" });
      return new Response(bytesStream(textStream), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const resp1 = await forward(openaiChatStreamRequest([{ role: "user", content: "a" }]));
    const frames1 = await collectSSEFrames(resp1.body);
    const chunks1 = frames1.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data));
    expect(chunks1.some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(true);

    const resp2 = await forward(openaiChatStreamRequest([{ role: "user", content: "b" }]));
    const frames2 = await collectSSEFrames(resp2.body);
    const chunks2 = frames2.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data));
    // second call must NOT inherit the first call's tool block
    expect(chunks2.some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(false);
    const text = chunks2
      .filter((c) => typeof c.choices?.[0]?.delta?.content === "string")
      .map((c) => c.choices[0].delta.content)
      .join("");
    expect(text).toBe("plain answer");
  });
}

{
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
}
  it("through translate(): target receives disable_parallel_tool_use=true", async () => {
    const captured = await translateCapturing(
      { parallel_tool_calls: false, messages: [{ role: "user", content: "hi" }] },
      openAiJsonResponse,
    );
    expect(captured.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("through translate(): target receives adaptive thinking with effort", async () => {
    const captured = await translateCapturing(
      { reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
      openAiJsonResponse,
    );
    expect(captured.thinking).toEqual({ type: "adaptive" });
    expect(captured.output_config).toEqual({ effort: "high" });
  });
describe("official SDK parses streamed tool calls (NFR-007)", () => {
  it("OpenAI SDK sees tool_calls from an Anthropic tool_use stream", async () => {
    const anthropicFetch = (async () =>
      new Response(bytesStream(anthropicToolStream({ id: "toolu_1", name: "get_weather" })), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch: anthropicFetch });
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://api.anthropic.com/v1",
      fetch: (url: RequestInfo | URL, init?: RequestInit) => forward(new Request(url, init)),
    });

    const stream = await client.chat.completions.create({
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] = [];
    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.tool_calls) toolCalls.push(...chunk.choices[0].delta.tool_calls);
    }
    expect(toolCalls.length).toBeGreaterThan(0);
    const byIndex = new Map<number, string>();
    for (const tc of toolCalls) {
      byIndex.set(tc.index, (byIndex.get(tc.index) ?? "") + (tc.function?.arguments ?? ""));
    }
    expect(byIndex.get(0)).toBe('{"arg":0}');
  });
});
describe("NONSTREAM-004 multi tool_result ordering (C -> A)", () => {
  const toolFlowMessages = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"city":"Paris"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "sunny, 25C" },
    { role: "tool", tool_call_id: "call_b", content: "14:00" },
    { role: "user", content: "thanks" },
  ];

  it("normalizes to a single Anthropic user turn with tool_result first", async () => {
    const captured = await translateCapturing(
      { messages: toolFlowMessages as never },
      openAiJsonResponse,
    );
    const msgs = captured.messages as Array<{ role: string; content: unknown }>;
    const userTurns = msgs.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);
    const blocks = userTurns[0].content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(blocks[0]).toMatchObject({ tool_use_id: "call_a" });
    expect(blocks[1]).toMatchObject({ tool_use_id: "call_b" });
    expect(blocks[2]).toMatchObject({ type: "text", text: "thanks" });
  });
});
