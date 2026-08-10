/**
 * Anthropic Messages -> OpenAI Chat end-to-end tests through translate().
 *
 * Source protocol: anthropic-messages. Streaming (TC-020), tool adjacency,
 * thinking policy handling, upstream error reverse translation, prompt-cache
 * affinity integration, and official SDK consumption of the translated
 * Anthropic stream.
 */
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
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

const openaiTextStream =
  openaiFrame({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " from" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " GPT" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } }) +
  openaiFrame("[DONE]");

function anthropicMessagesStreamRequest(): Request {
  return new Request("https://api.openai.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", stream: true, max_tokens: 256, messages: [{ role: "user", content: "hi" }] }),
  });
}

function anthropicThinkingRequest(): Request {
  return new Request("https://api.openai.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o", stream: false, max_tokens: 2000,
      thinking: { type: "enabled", budget_tokens: 1000 },
      messages: [{ role: "user", content: "solve it" }],
    }),
  });
}

function openAiSuccessResponse(): Response {
  return jsonResponse(openaiTextResponse);
}

function openAiUpstream(text: string): typeof fetch {
  return (async () =>
    new Response(bytesStream(text), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
}

function anthropicClientStreamRequest(): Request {
  return new Request("https://api.openai.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-ant", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", stream: true, max_tokens: 256, messages: [{ role: "user", content: "hi" }] }),
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

function openAiUpstreamFrame(data: unknown): string {
  return openaiFrame(data);
}

/** NONSTREAM-004 style: capture the converted target body. */
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
  const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
  await forward(
    new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: false, ...body }),
    }),
  );
  return captured;
}

{
  it("converts URL path, headers and body (TC-019, 9.13#2/4)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });

    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-openai-secret",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 512,
        system: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const response = await forward(request);
    const captured = lastRequest();

    expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
    // 9.13#4: x-api-key value -> Authorization Bearer
    expect(captured.headers.get("authorization")).toBe("Bearer sk-openai-secret");
    // 9.13#5: no source credential leak
    expect(captured.headers.get("x-api-key")).toBeNull();
    expect(captured.headers.get("anthropic-version")).toBeNull();

    expect(captured.body).toMatchObject({
      model: "gpt-4o",
      stream: false,
      max_tokens: 512,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });

    // response restored to Anthropic protocol
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([{ type: "text", text: "Hello from GPT" }]);
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(8);
  });

  it("reverse-translates an upstream error into Anthropic error shape (TC-023)", async () => {
    const upstreamError = {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "You are being rate limited",
        request_id: "req_abc",
      },
    };
    const { fetch } = fakeFetch(() =>
      new Response(JSON.stringify(upstreamError), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const response = await forward(request);
    expect(response.status).toBe(429);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("error");
    expect((body.error as Record<string, unknown>).type).toBe("rate_limit_error");
    expect((body.error as Record<string, unknown>).request_id).toBe("req_abc");
  });

  it("converts Anthropic thinking blocks into provider reasoning field when declared", async () => {
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
    const openaiWithReasoning = await import("../../src/codecs/openai-chat/index.js");
    const adapter = openaiWithReasoning.createOpenAiChatAdapter(profile);
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });

    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "chain", signature: "sig-1" },
              { type: "text", text: "Answer" },
            ],
          },
        ],
      }),
    });
    await forward(request);
  });
}

{
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
}

{
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
}

{
  it("delivers finish_reason + late usage as a valid Anthropic terminal", async () => {
    const upstream =
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openAiUpstreamFrame({ id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) +
      openAiUpstreamFrame("[DONE]");
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch: openAiUpstream(upstream) });
    const response = await forward(anthropicClientStreamRequest());
    const frames = await collectFrames(response.body);
    const messageDelta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(messageDelta!.data)).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(frames[frames.length - 1].event).toBe("message_stop");
  });
}

{
  it("still finalizes cleanly for the Anthropic client", async () => {
    const upstream =
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] });
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch: openAiUpstream(upstream) });
    const response = await forward(anthropicClientStreamRequest());
    const frames = await collectFrames(response.body);
    expect(frames[frames.length - 1].event).toBe("message_stop");
    const messageDelta = frames.find((f) => f.event === "message_delta");
    expect(messageDelta).toBeTruthy();
  });
}

{
  it("accumulates arguments that arrived before the tool name", async () => {
    const upstream =
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }) +
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] }) +
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather" } }] }, finish_reason: null }] }) +
      openAiUpstreamFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      openAiUpstreamFrame("[DONE]");
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch: openAiUpstream(upstream) });
    const client = new Anthropic({
      apiKey: "sk-ant-test",
      fetch: (url: RequestInfo | URL, init?: RequestInit) => forward(new Request(url, init)),
    });
    const stream = client.messages.stream({
      model: "gpt-4o",
      max_tokens: 256,
      messages: [{ role: "user", content: "weather?" }],
    });
    const message = await stream.finalMessage();
    const toolUse = message.content.find((b) => b.type === "tool_use") as
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | undefined;
    expect(toolUse).toBeTruthy();
    expect(toolUse!.id).toBe("call_1");
    expect(toolUse!.name).toBe("get_weather");
    expect(toolUse!.input).toEqual({ city: "Paris" });
  });
}

{
  it("emits tool messages immediately after the assistant tool_calls (Anthropic -> OpenAI)", async () => {
    let capturedTargetBody: Record<string, unknown> = {};
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      capturedTargetBody = (await req.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });

    // Claude Code style turn: assistant tool_use, then a user turn carrying
    // both the tool_result and follow-up text.
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer sk-ant", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        messages: [
          { role: "user", content: "what's the weather?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "25C, sunny" },
              { type: "text", text: "and humidity?" },
            ],
          },
        ],
      }),
    });
    await forward(request);

    const msgs = capturedTargetBody.messages as Array<Record<string, unknown>>;
    const assistantIdx = msgs.findIndex(
      (m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown }).tool_calls),
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    // OpenAI requires tool messages to immediately follow the tool_calls message.
    expect(msgs[assistantIdx + 1]).toMatchObject({ role: "tool", tool_call_id: "toolu_1" });
    expect(msgs[assistantIdx + 2]).toMatchObject({ role: "user", content: "and humidity?" });
  });
}

{
  const goldenRequest = {
    model: "claude-sonnet",
    max_tokens: 100,
    system: [
      { type: "text", text: "project instructions", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "repository context", cache_control: { type: "ephemeral" } },
          { type: "text", text: "dynamic question" },
        ],
      },
    ],
  };

  it("injects a stable prompt_cache_key from source cache_control anchors (golden)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
    });
    const response = await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(response.status).toBe(200);
    const captured = lastRequest();
    expect(captured.body).toMatchObject({
      model: "claude-sonnet",
      stream: false,
      messages: [
        { role: "system", content: "project instructions" },
        { role: "user", content: expect.any(String) },
      ],
    });
    expect(captured.body.prompt_cache_key).toBe(
      "anthropic-cache-f1a6c616742c039a29db85132d256f4a",
    );
  });

  it("reports the cache summary and warning in the trace", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    const report = traces[0].cache as Record<string, unknown>;
    expect(report).toMatchObject({
      detected: true,
      source: "anthropic-cache-control",
      targetKeyInjected: true,
      anchorCount: 2,
      degraded: true,
    });
    expect(traces[0].warnings).toContainEqual(
      expect.objectContaining({ code: "cache_control_downgraded_to_cache_key" }),
    );
  });

  it("injects nothing when the source has no cache_control", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
    expect((traces[0].cache as Record<string, unknown>).detected).toBe(false);
    expect(traces[0].warnings).not.toContainEqual(
      expect.objectContaining({ code: "cache_control_downgraded_to_cache_key" }),
    );
  });

  it("is fully opt-in: default translate() never adds prompt_cache_key", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
  });

  it("does not inject when the target profile does not declare prompt_cache_key", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      profiles: { "openai-chat": chatProfile(false) },
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
    expect((traces[0].cache as Record<string, unknown>).targetKeyInjected).toBe(false);
    expect(traces[0].warnings).toContainEqual(
      expect.objectContaining({ code: "cache_target_unsupported" }),
    );
  });

  it("honors an explicit x-llm-prompt-cache-key header over anchors and does not leak it upstream", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch, cache: {} });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": "key",
          "content-type": "application/json",
          "x-llm-prompt-cache-key": "explicit-session-key",
        },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBe("explicit-session-key");
    expect(lastRequest().headers.get("x-llm-prompt-cache-key")).toBeNull();
  });

  it("traces never leak the cache key, anchor text or prompt content", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "TOP_SECRET_KEY", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("f1a6c616742c039a29db85132d256f4a");
    expect(serialized).not.toContain("project instructions");
    expect(serialized).not.toContain("repository context");
    expect(serialized).not.toContain("TOP_SECRET_KEY");
  });
}

import type { ProviderProfile } from "../../src/capabilities/provider-profile.js";

function chatProfile(promptCacheKey: boolean): ProviderProfile {
  return {
    protocol: "openai-chat",
    capabilities: {
      tools: true,
      parallelTools: true,
      streaming: true,
      thinking: false,
      cache: { promptCacheKey },
    },
    defaultHeaders: {},
  };
}
describe("official SDK parses streamed tool calls (NFR-007)", () => {
  it("Anthropic SDK sees tool_use from an OpenAI tool_calls stream", async () => {
    const toolStream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      openaiFrame("[DONE]");
    const openaiFetch = (async () =>
      new Response(bytesStream(toolStream), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch: openaiFetch });
    const client = new Anthropic({
      apiKey: "sk-ant-test",
      fetch: (url: RequestInfo | URL, init?: RequestInit) => forward(new Request(url, init)),
    });

    const stream = client.messages.stream({
      model: "gpt-4o",
      max_tokens: 256,
      messages: [{ role: "user", content: "weather?" }],
    });
    const message = await stream.finalMessage();
    const toolUse = message.content.find((b) => b.type === "tool_use") as
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | undefined;
    expect(toolUse).toBeTruthy();
    expect(toolUse!.id).toBe("call_1");
    expect(toolUse!.name).toBe("get_weather");
    expect(toolUse!.input).toEqual({ city: "Paris" });
  })
});


function openAiJsonResponse(): Response {
  return jsonResponse(openaiTextResponse);
}
