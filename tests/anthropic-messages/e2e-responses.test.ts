/**
 * Anthropic Messages -> OpenAI Responses end-to-end tests through translate().
 *
 * Source protocol: anthropic-messages. System/developer item splitting and
 * Responses SSE -> Anthropic client SSE terminal translation.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

describe("anthropic-messages -> openai-responses e2e", () => {
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
});
