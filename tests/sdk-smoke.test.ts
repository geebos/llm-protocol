/**
 * Official SDK smoke tests (NFR-007, acceptance criterion 4).
 *
 * The OpenAI JS SDK and the Anthropic JS SDK consume the stream produced by
 * translate() through a custom fetch, proving the rendered SSE is parseable by
 * the respective official clients. No real provider is contacted.
 */
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { translate } from "../src/pipeline/translate.js";

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

const anthropicTextStream =
  anthropicFrame("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: {} } }) +
  anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from" } }) +
  anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Claude" } }) +
  anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 4 } }) +
  anthropicFrame("message_stop", { type: "message_stop" });

const openaiTextStream =
  openaiFrame({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hello from" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " GPT" }, finish_reason: null }] }) +
  openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }) +
  openaiFrame("[DONE]");

describe("OpenAI JS SDK parses translate() output (Anthropic upstream)", () => {
  it("consumes the OpenAI SSE stream and aggregates text", async () => {
    const anthropicFetch = (async () =>
      new Response(bytesStream(anthropicTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch: anthropicFetch });
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://api.anthropic.com/v1",
      fetch: (url: RequestInfo | URL, init?: RequestInit) =>
        forward(new Request(url, init)),
    });

    const stream = await client.chat.completions.create({
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    let text = "";
    let finishReason: string | null = null;
    let sawUsage = false;
    for await (const chunk of stream) {
      expect(chunk.object).toBe("chat.completion.chunk");
      if (chunk.choices[0]?.delta?.content) text += chunk.choices[0].delta.content;
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) sawUsage = true;
    }
    expect(text).toBe("Hello from Claude");
    expect(finishReason).toBe("stop");
    expect(sawUsage).toBe(true);
  });
});

describe("Anthropic JS SDK parses translate() output (OpenAI upstream)", () => {
  it("consumes the Anthropic SSE stream and aggregates the final message", async () => {
    const openaiFetch = (async () =>
      new Response(bytesStream(openaiTextStream), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch: openaiFetch });
    const client = new Anthropic({
      apiKey: "sk-ant-test-key",
      fetch: (url: RequestInfo | URL, init?: RequestInit) =>
        forward(new Request(url, init)),
    });

    const stream = client.messages.stream({
      model: "gpt-4o",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    const message = await stream.finalMessage();

    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.content[0].type).toBe("text");
    expect(message.content[0].text).toBe("Hello from GPT");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage.input_tokens).toBe(7);
    expect(message.usage.output_tokens).toBe(4);
  });
});
