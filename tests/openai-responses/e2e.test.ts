/**
 * OpenAI Responses end-to-end tests through translate().
 *
 * Source protocol: openai-responses. Non-streaming (text to Anthropic /
 * Chat, upstream error reverse translation) and streaming (Anthropic
 * upstream -> Responses SSE dual lifecycle, truncation -> incomplete,
 * early-EOF safety). Public API only.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
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

function dataFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
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

interface WireEvent {
  type: string;
  [key: string]: unknown;
}

async function collectResponsesEvents(body: ReadableStream<Uint8Array> | null): Promise<WireEvent[]> {
  const frames = await collectSSEFrames(body);
  return frames.filter((f) => f.data !== "[DONE]").map((f) => JSON.parse(f.data) as WireEvent);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function responsesRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer key", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const anthropicTextResponse = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
};

const chatTextResponse = {
  id: "chatcmpl_456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello from GPT" }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

const anthropicTextStream =
  anthropicFrame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: {} } }) +
  anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Responses" } }) +
  anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 7 } }) +
  anthropicFrame("message_stop", { type: "message_stop" });

describe("responses e2e: non-streaming", () => {
  it("Responses -> Anthropic: converts input and restores the Anthropic response", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      expect(req.url).toBe("https://api.example.com/v1/messages");
      return jsonResponse(anthropicTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "anthropic-messages", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", {
        model: "claude-sonnet-4-5",
        input: "Hello",
      }),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({ type: "message", status: "completed", role: "assistant" });
    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "output_text", text: "Hello from Claude" });
    // usage composed back into Responses shape
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(8);
  });
  it("Responses -> Chat: reasoning summary maps to assistant content path", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      expect(req.url).toBe("https://api.example.com/v1/chat/completions");
      return jsonResponse(chatTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "openai-chat", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", {
        model: "gpt-4o",
        input: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      }),
    );
    // client speaks Responses: output restored to Responses shape
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    const output = body.output as Array<Record<string, unknown>>;
    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "output_text", text: "Hello from GPT" });
  });
  it("reverse-translates a Responses upstream error into the source protocol", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down", param: null, type: "rate_limit_error" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "openai-chat", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", { model: "m", input: "hi" }),
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as Record<string, unknown>;
    // Chat error shape restored for the Responses caller
    expect(body).toHaveProperty("error");
  });
});

describe("responses e2e: streaming", () => {
  it("Anthropic upstream SSE -> Responses client SSE: text + dual lifecycle", async () => {
    const fetchImpl = (async () =>
      new Response(bytesStream(anthropicTextStream), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "anthropic-messages", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", { model: "m", input: "hi", stream: true }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await collectResponsesEvents(response.body);
    const types = events.map((e) => e.type);
    // lifecycle + item/content dual lifecycle + single terminal
    expect(types.slice(0, 3)).toEqual(["response.created", "response.queued", "response.in_progress"]);
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    const text = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta as string)
      .join("");
    expect(text).toBe("Hello Responses");
    const completed = events.filter((e) => e.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].response).toMatchObject({ status: "completed" });
    // usage folded into the terminal envelope once
    expect((completed[0].response as Record<string, unknown>).usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 7,
    });
    // review P0-3: the terminal output[] carries the FINAL text payload, not
    // the empty content captured at output_item.added.
    const output = (completed[0].response as { output?: Array<Record<string, unknown>> }).output ?? [];
    expect(output[0]).toMatchObject({ type: "message", status: "completed" });
    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "output_text", text: "Hello Responses" });
  });
  it("Upstream truncation surfaces as response.incomplete (P0-1)", async () => {
    const chatTruncated =
      dataFrame({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      dataFrame({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o", choices: [{ index: 0, delta: { content: "cut" }, finish_reason: null }] }) +
      dataFrame({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      dataFrame("[DONE]");

    const fetchImpl = (async () =>
      new Response(bytesStream(chatTruncated), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "openai-chat", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", { model: "m", input: "hi", stream: true }),
    );
    const events = await collectResponsesEvents(response.body);
    const incomplete = events.filter((e) => e.type === "response.incomplete");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].response).toMatchObject({ status: "incomplete" });
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });
  it("A stream that closes without a terminal still ends safely (SR-002)", async () => {
    const earlyEnd =
      dataFrame({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      dataFrame({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });

    const fetchImpl = (async () =>
      new Response(bytesStream(earlyEnd), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "openai-chat", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/responses", { model: "m", input: "hi", stream: true }),
    );
    const events = await collectResponsesEvents(response.body);
    // translated stream still terminates with exactly one terminal event
    const terminals = events.filter(
      (e) => e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed",
    );
    expect(terminals).toHaveLength(1);
  });

  it("Responses upstream terminal usage reaches the Chat client (review P0)", async () => {
    // §14.3: Responses returns usage on the terminal SSE event; the parser
    // must aggregate it into a canonical usage event before message_end so the
    // Chat client's final chunk carries prompt/completion tokens (review
    // round 2: this used to vanish entirely). Source = Chat (client), target =
    // Responses (upstream).
    const responsesStream =
      dataFrame({ type: "response.created", response: { id: "resp_1", model: "gpt-4o" } }) +
      dataFrame({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }) +
      dataFrame({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
      dataFrame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hi" }) +
      dataFrame({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hi" }) +
      dataFrame({ type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: {} }) +
      dataFrame({ type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message" } }) +
      dataFrame({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      });

    const fetchImpl = (async () =>
      new Response(bytesStream(responsesStream), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "openai-responses", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    const frames = await collectSSEFrames(response.body);
    const chunks = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>);
    const usageChunks = chunks.filter((c) => c.usage !== undefined);
    expect(usageChunks.length).toBeGreaterThan(0);
    expect(usageChunks[usageChunks.length - 1].usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    // the terminal chunk still carries the finish reason
    expect(chunks.some((c) => (c.choices as Array<{ finish_reason?: string }>)?.[0]?.finish_reason === "stop")).toBe(true);
  });
});
