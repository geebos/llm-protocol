/**
 * M3 tool-calling tests through translate().
 *
 * TC-006 multi-turn tool result re-injection, TC-008 parallel tool calls,
 * TR-002 synthesized tool ids reported, TC-021 reused factory never leaks
 * per-stream state, and official SDK tool-call stream parsing.
 */
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { translate } from "../src/pipeline/translate.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";
import type { TranslationTrace } from "../src/pipeline/types.js";

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

function anthropicToolStream(...blocks: Array<{ id: string; name: string }>): string {
  let s =
    anthropicFrame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: {} } });
  blocks.forEach((b, i) => {
    s += anthropicFrame("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
    s += anthropicFrame("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: `{"arg":${i}}` } });
    s += anthropicFrame("content_block_stop", { type: "content_block_stop", index: i });
  });
  s += anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
  s += anthropicFrame("message_stop", { type: "message_stop" });
  return s;
}

function openaiChatStreamRequest(messages: unknown[]): Request {
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

describe("TC-008 parallel tool calls (Anthropic upstream)", () => {
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
});

describe("TC-006 multi-turn tool result re-injection", () => {
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
});

describe("TR-002 synthesized tool ids are reported", () => {
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
});

describe("TC-021 reused factory never leaks per-stream state", () => {
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
  });
});
