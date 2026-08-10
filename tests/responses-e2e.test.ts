/**
 * OpenAI Responses end-to-end tests through translate() (responses.md §16,
 * D-7). Public API only: source Request -> canonical IR -> target protocol,
 * both non-streaming and streaming.
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

function dataFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

interface WireEvent {
  type: string;
  [key: string]: unknown;
}

async function collectResponsesEvents(
  body: ReadableStream<Uint8Array> | null,
): Promise<WireEvent[]> {
  const frames = await collectSSEFrames(body);
  return frames
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as WireEvent);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responsesRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer key", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const responsesTextResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1700000000,
  status: "completed",
  model: "gpt-4o",
  output: [
    { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hello from Responses" }] },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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

const chatTextResponse = {
  id: "chatcmpl_456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello from GPT" }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

/* ------------------------------------------------------------------ */
/* non-streaming                                                      */
/* ------------------------------------------------------------------ */

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

  it("Anthropic -> Responses: splits system/messages into items", async () => {
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      expect(req.url).toBe("https://api.example.com/v1/responses");
      captured = await req.json();
      return jsonResponse(responsesTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "anthropic-messages", to: "openai-responses", fetch: fetchImpl });
    const response = await forward(
      new Request("https://api.example.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          system: "Be brief.",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
    );
    // client speaks Anthropic: the response is restored to Anthropic shape
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Hello from Responses" });
    // the upstream (Responses) request carries developer + user items
    const input = captured as Record<string, unknown>;
    expect(input.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Be brief." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ]);
  });

  it("Chat -> Responses: assistant tool_calls become independent items", async () => {
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      captured = await req.json();
      return jsonResponse(responsesTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "openai-responses", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      }),
    );
    // client speaks Chat: response restored to chat.completion shape
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    // upstream (Responses) request: tool calls are independent items
    const input = captured as { input?: unknown };
    const items = input.input as Array<Record<string, unknown>>;
    expect(items).toContainEqual({ type: "function_call", name: "get_weather", call_id: "call_1", arguments: "{\"city\":\"Paris\"}" });
    expect(items).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "sunny" });
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

/* ------------------------------------------------------------------ */
/* streaming                                                          */
/* ------------------------------------------------------------------ */

describe("responses e2e: streaming", () => {
  const responsesTextStream =
    dataFrame({ type: "response.created", response: { id: "resp_1", model: "gpt-4o", status: "queued", output: [] } }) +
    dataFrame({ type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } }) +
    dataFrame({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }) +
    dataFrame({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
    dataFrame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" }) +
    dataFrame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: " Responses" }) +
    dataFrame({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello Responses" }) +
    dataFrame({ type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: {} }) +
    dataFrame({ type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }) +
    dataFrame({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } },
    });

  const anthropicTextStream =
    anthropicFrame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: {} } }) +
    anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
    anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Responses" } }) +
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 7 } }) +
    anthropicFrame("message_stop", { type: "message_stop" });

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

  it("Responses upstream SSE -> Anthropic client SSE: named events + terminal", async () => {
    const fetchImpl = (async () =>
      new Response(bytesStream(responsesTextStream), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const forward = translate({ from: "anthropic-messages", to: "openai-responses", fetch: fetchImpl });
    const response = await forward(
      new Request("https://api.example.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
    );
    const frames = await collectSSEFrames(response.body);
    const events = frames.map((f) => f.event);
    expect(events).toContain("content_block_start");
    expect(events).toContain("content_block_delta");
    const text = frames
      .filter((f) => f.event === "content_block_delta")
      .map((f) => (JSON.parse(f.data) as { delta: { text?: string } }).delta.text ?? "")
      .join("");
    expect(text).toBe("Hello Responses");
    const messageDelta = frames.filter((f) => f.event === "message_delta");
    expect(messageDelta).toHaveLength(1);
    expect((JSON.parse(messageDelta[0].data) as { delta: { stop_reason?: string } }).delta.stop_reason).toBe("end_turn");
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
});
