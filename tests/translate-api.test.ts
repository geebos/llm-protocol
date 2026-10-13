/**
 * New unified `translate.<source>.<target>(options)` API (05.translate-api.md).
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/index.js";
import type { PrivacyRecognizer, TranslateCompletion, TranslationTrace } from "../src/index.js";
import { createSSEParser } from "../src/streams/index.js";

interface Captured {
  url: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): {
  fetch: typeof fetch;
  lastRequest: () => Captured;
} {
  let captured: Captured | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = { url: req.url, headers: new Headers(req.headers), body: await req.json() };
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
};

const chatResponse = {
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

const encoder = new TextEncoder();

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
      model: "claude",
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
    delta: { type: "text_delta", text: "Hello" },
  }) +
  anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  anthropicFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 2, output_tokens: 1 },
  }) +
  anthropicFrame("message_stop", { type: "message_stop" });

function streamingResponse(text = anthropicStream): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
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

const ANTHROPIC_HEADERS = { "x-api-key": "sk-key", "anthropic-version": "2023-06-01" };

describe("translate namespace", () => {
  it("exposes all 9 source->target selectors", () => {
    for (const source of ["messages", "chat", "responses"] as const) {
      for (const target of ["messages", "chat", "responses"] as const) {
        expect(typeof translate[source][target]).toBe("function");
      }
    }
  });

  it("rejects unsupported responses combinations with kind=unsupported", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    await expect(
      translate.responses.messages({ url: "https://x/v1/messages", body: {}, fetch }),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await expect(
      translate.messages.responses({ url: "https://x/v1/responses", body: {}, fetch }),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });
});

describe("translate options", () => {
  it("uses url and headers verbatim and defaults content-type", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages?beta=1",
      headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" },
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    const captured = lastRequest();
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages?beta=1");
    expect(captured.headers.get("x-api-key")).toBe("k");
    expect(captured.headers.get("content-type")).toBe("application/json");
    expect(captured.body).toMatchObject({ model: "claude-sonnet-4-5" });
  });

  it("accepts a serialized JSON string body", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
      fetch,
    });
    expect(lastRequest().body).toMatchObject({ model: "claude-sonnet-4-5" });
  });

  it("rejects an invalid JSON string body with a validation error", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    let done: TranslateCompletion | undefined;
    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        body: "not json {",
        onComplete: (r) => {
          done = r;
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(done?.status).toBe("errored");
    expect(done?.error?.kind).toBe("validation");
  });

  it("notifies onComplete exactly once when the privacy config is invalid", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    let count = 0;
    let done: TranslateCompletion | undefined;
    await expect(
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
        privacy: { recognizers: [] },
        onComplete: (r) => {
          count++;
          done = r;
        },
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(count).toBe(1);
    expect(done?.status).toBe("errored");
    expect(done?.error?.kind).toBe("validation");
  });

  it("isolates an onPrivacyComplete exception from the request result", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "call 13800138000" }] },
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: () => {
        throw new Error("observer boom");
      },
      fetch,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Hello");
  });

  it("overrides the model even when the body omits it", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { messages: [{ role: "user", content: "hi" }] },
      model: "claude-override",
      fetch,
    });
    expect((lastRequest().body as Record<string, unknown>).model).toBe("claude-override");
  });

  it("renders includeUsage into the Chat stream_options and drops it for Anthropic", async () => {
    const chat = fakeFetch(() => jsonResponse(chatResponse));
    await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
      includeUsage: true,
      fetch: chat.fetch,
    });
    expect((chat.lastRequest().body as Record<string, unknown>).stream_options).toEqual({
      include_usage: true,
    });

    const traces: TranslationTrace[] = [];
    const anthropic = fakeFetch(() => jsonResponse(anthropicResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      includeUsage: true,
      trace: (t) => traces.push(t),
      fetch: anthropic.fetch,
    });
    expect(anthropic.lastRequest().body).not.toHaveProperty("stream_options");
    expect(traces[0].warnings).toEqual([]);
  });

  it("honors an explicit stream override", async () => {
    const { fetch, lastRequest } = fakeFetch(() => streamingResponse());
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      fetch,
    });
    expect((lastRequest().body as Record<string, unknown>).stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});

describe("onComplete", () => {
  it("reports non-streaming success exactly once", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    let count = 0;
    let done: TranslateCompletion | undefined;
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      logid: "lg_test",
      onComplete: (r) => {
        count++;
        done = r;
      },
      fetch,
    });
    expect(response.status).toBe(200);
    expect(count).toBe(1);
    expect(done?.status).toBe("completed");
    expect(done?.logid).toBe("lg_test");
    expect(done?.from).toBe("openai-chat");
    expect(done?.to).toBe("anthropic-messages");
    expect(done?.requestBody).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(done?.upstreamStatus).toBe(200);
    expect(done?.responseHeaders).toBeInstanceOf(Headers);
    expect(done?.responseBody).toMatchObject({ object: "chat.completion" });
    expect(done?.usage).toEqual({ input: 8, output: 4, cacheRead: 0, cacheWrite: 0 });
    expect(done?.ttft).toBeUndefined();
    expect(done?.error).toBeUndefined();
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("buffers canonical SSE events for streaming calls", async () => {
    const { fetch } = fakeFetch(() => streamingResponse());
    let done: TranslateCompletion | undefined;
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "hi" }] },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    await drain(response.body);
    expect(done?.status).toBe("completed");
    expect(done?.responseBody).toBeUndefined();
    expect(done?.sseEvents?.some((e) => e.type === "message_end")).toBe(true);
    expect(done?.sseEventsTruncated).toBe(false);
    expect(done?.usage).toMatchObject({ input: 2, output: 1 });
    // TTFT is measured at the first content delta and never exceeds the total.
    expect(typeof done?.ttft).toBe("number");
    expect(done?.ttft).toBeGreaterThanOrEqual(0);
    expect(done?.ttft!).toBeLessThanOrEqual(done!.durationMs);
  });

  it("measures ttft from the first content delta (streaming)", async () => {
    const head =
      anthropicFrame("message_start", {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} },
      }) +
      anthropicFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    const tail =
      anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(head));
        await new Promise((r) => setTimeout(r, 120));
        controller.enqueue(encoder.encode(tail));
        controller.close();
      },
    });
    const fetch = (async () =>
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    let done: TranslateCompletion | undefined;
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "hi" }] },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    await drain(response.body);
    expect(done?.ttft).toBeGreaterThanOrEqual(100);
    expect(done?.durationMs).toBeGreaterThanOrEqual(done?.ttft ?? 0);
  });

  it("reports upstream 4xx as completed with an error", async () => {
    const { fetch } = fakeFetch(() =>
      new Response(JSON.stringify({ error: { message: "bad key", type: "invalid_request_error" } }), {
        status: 401,
      }),
    );
    let done: TranslateCompletion | undefined;
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    expect(response.status).toBe(401);
    expect(done?.status).toBe("completed");
    expect(done?.upstreamStatus).toBe(401);
    expect(done?.error?.kind).toBeDefined();
  });

  it("isolates callback exceptions", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      onComplete: () => {
        throw new Error("observer boom");
      },
      fetch,
    });
    expect(response.status).toBe(200);
  });

  it("generates and correlates logid across trace and onComplete", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicResponse));
    let trace: TranslationTrace | undefined;
    let done: TranslateCompletion | undefined;
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
      trace: (t) => {
        trace = t;
      },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    expect(typeof done?.logid).toBe("string");
    expect((done?.logid ?? "").length).toBeGreaterThan(8);
    expect(trace?.logid).toBe(done?.logid);
    expect(trace?.traceId).toBe(done?.logid);
  });
});

describe("unified usage", () => {
  it("splits Chat cache reads out of prompt tokens", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        ...chatResponse,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
    );
    let done: TranslateCompletion | undefined;
    await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    expect(done?.usage).toEqual({ input: 7, output: 5, cacheRead: 3, cacheWrite: 0 });
  });
});

describe("privacy observation boundary", () => {
  it("keeps onComplete at the restore-before view and the Response restored", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        ...anthropicResponse,
        content: [{ type: "text", text: "call <private_placeholder_phone_1> now" }],
      }),
    );
    let done: TranslateCompletion | undefined;
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: ANTHROPIC_HEADERS,
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "call 13800138000" }] },
      privacy: { recognizers: [phoneRecognizer()] },
      onComplete: (r) => {
        done = r;
      },
      fetch,
    });
    const client = JSON.stringify(await response.json());
    expect(client).toContain("13800138000");
    const observed = JSON.stringify(done?.responseBody);
    expect(observed).toContain("<private_placeholder_phone_1>");
    expect(observed).not.toContain("13800138000");
  });
});
