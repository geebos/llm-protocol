/**
 * M2 streaming unit tests: SSE parser (SR-001), protocol stream parse/render.
 */
import { describe, expect, it } from "vitest";
import {
  createSSEParser,
  createAnthropicStreamParser,
  createAnthropicStreamRenderer,
  createOpenAiChatStreamParser,
  createOpenAiChatStreamRenderer,
  type SSEFrame,
  type CanonicalStreamEvent,
} from "../src/streams/index.js";
import { openaiChatDefaultProfile } from "../src/codecs/openai-chat/index.js";
import { DEFAULT_POLICIES } from "../src/ir/policies.js";
import type { TranslationWarning } from "../src/ir/fidelity.js";

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function bytesStream(text: string, chunkSize = Infinity): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkSize === Infinity) {
        controller.enqueue(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        }
      }
      controller.close();
    },
  });
}

async function parseSSE(
  text: string,
  chunkSize = Infinity,
): Promise<SSEFrame[]> {
  return collect(bytesStream(text, chunkSize).pipeThrough(createSSEParser()));
}

async function parseAnthropicStream(
  text: string,
  chunkSize = Infinity,
): Promise<CanonicalStreamEvent[]> {
  return collect(
    bytesStream(text, chunkSize)
      .pipeThrough(createSSEParser())
      .pipeThrough(createAnthropicStreamParser()),
  );
}

async function parseOpenAiStream(
  text: string,
  chunkSize = Infinity,
  reasoningField?: string,
): Promise<CanonicalStreamEvent[]> {
  const profile = {
    ...openaiChatDefaultProfile,
    capabilities: {
      ...openaiChatDefaultProfile.capabilities,
      ...(reasoningField ? { reasoningField } : {}),
    },
  };
  return collect(
    bytesStream(text, chunkSize)
      .pipeThrough(createSSEParser())
      .pipeThrough(createOpenAiChatStreamParser(profile)),
  );
}

function eventsToBytes(events: CanonicalStreamEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  }).pipeThrough(createAnthropicStreamRenderer());
}

function eventsToBytesOpenAi(
  events: CanonicalStreamEvent[],
  reasoningField?: string,
): ReadableStream<Uint8Array> {
  const profile = {
    ...openaiChatDefaultProfile,
    capabilities: {
      ...openaiChatDefaultProfile.capabilities,
      ...(reasoningField ? { reasoningField } : {}),
    },
  };
  return new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  }).pipeThrough(createOpenAiChatStreamRenderer(profile));
}

async function renderAnthropicFrames(
  events: CanonicalStreamEvent[],
): Promise<SSEFrame[]> {
  return collect(eventsToBytes(events).pipeThrough(createSSEParser()));
}

async function renderOpenAiFrames(
  events: CanonicalStreamEvent[],
  reasoningField?: string,
): Promise<string[]> {
  const bytes = eventsToBytesOpenAi(events, reasoningField);
  const parser = createSSEParser();
  const frames = await collect(bytes.pipeThrough(parser));
  return frames.map((f) => f.data);
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

describe("SSE parser (SR-001, TC-016)", () => {
  it("parses a basic data frame", async () => {
    const frames = await parseSSE("data: hello\n\n");
    expect(frames).toEqual([{ event: "message", data: "hello", id: undefined }]);
  });

  it("parses named events and ids", async () => {
    const frames = await parseSSE(
      "event: ping\nid: 1\ndata: {}\n\n",
    );
    expect(frames).toEqual([{ event: "ping", data: "{}", id: "1" }]);
  });

  it("joins multi-line data with newlines", async () => {
    const frames = await parseSSE("data: line1\ndata: line2\n\n");
    expect(frames[0].data).toBe("line1\nline2");
  });

  it("handles CRLF and comments", async () => {
    const frames = await parseSSE(
      ": a comment\r\n" + "data: x\r\n\r\n",
    );
    expect(frames).toEqual([{ event: "message", data: "x", id: undefined }]);
  });

  it("ignores a frame with only an id (no data)", async () => {
    const frames = await parseSSE("id: 5\n\n");
    expect(frames).toEqual([{ event: "message", data: "", id: "5" }]);
  });

  it("survives byte-level splitting including multi-byte UTF-8 (TC-016)", async () => {
    const input = "event: message_start\ndata: {\"text\":\"数据\"}\n\n";
    const frames1 = await parseSSE(input, 1);
    const framesAll = await parseSSE(input, 3);
    expect(frames1).toEqual(framesAll);
    expect(frames1[0].data).toBe('{"text":"数据"}');
  });

  it("survives a CR split across chunk boundaries", async () => {
    const frames = await parseSSE("data: a\r\ndata: b\r\n\r\n", 2);
    expect(frames).toEqual([{ event: "message", data: "a\nb", id: undefined }]);
  });

  it("flushes a trailing frame without a trailing blank line", async () => {
    const frames = await parseSSE("data: tail");
    expect(frames).toEqual([{ event: "message", data: "tail", id: undefined }]);
  });
});

describe("Anthropic SSE -> canonical (target parse)", () => {
  it("maps a full text message sequence", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "msg_1", model: "claude", type: "message", role: "assistant", content: [], stop_reason: null, usage: {} } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 3 } }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const events = await parseAnthropicStream(stream);
    expect(events).toEqual([
      { type: "message_start", id: "msg_1", model: "claude" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Hello" },
      { type: "text_delta", index: 0, text: " world" },
      { type: "text_end", index: 0 },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      { type: "message_end", finishReason: "end_turn" },
    ]);
  });

  it("maps a tool_use stream with incremental arguments", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", model: "c", content: [] } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city"' } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"Paris"}' } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const events = await parseAnthropicStream(stream);
    expect(events[1]).toEqual({ type: "tool_start", index: 0, id: "toolu_1", name: "get_weather" });
    expect(events[2]).toEqual({ type: "tool_arguments_delta", index: 0, partialJson: '{"city"' });
    expect(events[3]).toEqual({ type: "tool_arguments_delta", index: 0, partialJson: ':"Paris"}' });
    expect(events[4]).toEqual({ type: "tool_end", index: 0 });
    expect(events[5]).toEqual({ type: "message_end", finishReason: "tool_call" });
  });

  it("maps thinking and signature deltas opaquely (TH-002)", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", model: "c", content: [] } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig-0" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step 1" } }) +
      anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const events = await parseAnthropicStream(stream);
    expect(events[1]).toMatchObject({
      type: "reasoning_start",
      index: 0,
      metadata: { type: "thinking", signature: "sig-0" },
    });
    expect(events[2]).toEqual({ type: "reasoning_delta", index: 0, text: "step 1" });
    expect(events[3]).toEqual({ type: "reasoning_delta", index: 0, opaque: "sig-1" });
    expect(events[4]).toEqual({ type: "reasoning_end", index: 0 });
  });

  it("surfaces an in-stream error event (SR-006, TC-014)", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", model: "c", content: [] } }) +
      anthropicFrame("error", { type: "error", error: { type: "api_error", message: "boom" } });
    const events = await parseAnthropicStream(stream);
    expect(events[1]).toMatchObject({
      type: "error",
      error: { kind: "stream_protocol", message: "boom", providerCode: "api_error" },
    });
  });

  it("ignores ping and surfaces unknown events (SR-005, TC-017)", async () => {
    const stream =
      anthropicFrame("ping", {}) +
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", content: [] } }) +
      anthropicFrame("mystery_event", { foo: 1 });
    const events = await parseAnthropicStream(stream);
    expect(events.filter((e) => e.type === "unknown")).toHaveLength(1);
    expect(events[0]).toEqual({ type: "message_start", id: "m", model: undefined });
  });

  it("synthesizes message_end when only message_stop arrives", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", content: [] } }) +
      anthropicFrame("message_stop", { type: "message_stop" });
    const events = await parseAnthropicStream(stream);
    expect(events[events.length - 1]).toEqual({ type: "message_end" });
  });
});

describe("OpenAI SSE -> canonical (target parse)", () => {
  it("maps a text stream with finish_reason and [DONE]", async () => {
    const stream =
      openaiFrame({ id: "chatcmpl-1", model: "gpt", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] }) +
      openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] }) +
      openaiFrame({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openaiFrame("[DONE]");

    const events = await parseOpenAiStream(stream);
    expect(events).toEqual([
      { type: "message_start", id: "chatcmpl-1", model: "gpt" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Hel" },
      { type: "text_delta", index: 0, text: "lo" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
  });

  it("maps tool_calls with incremental arguments", async () => {
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      openaiFrame("[DONE]");

    const events = await parseOpenAiStream(stream);
    expect(events[1]).toEqual({ type: "tool_start", index: 0, id: "call_1", name: "get_weather" });
    expect(events[2]).toEqual({ type: "tool_arguments_delta", index: 0, partialJson: '{"city":' });
    expect(events[3]).toEqual({ type: "tool_arguments_delta", index: 0, partialJson: '"Paris"}' });
    expect(events[4]).toEqual({ type: "tool_end", index: 0 });
    expect(events[5]).toEqual({ type: "message_end", finishReason: "tool_call" });
  });

  it("maps reasoning_content only when the profile declares it (TH-003)", async () => {
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "chain" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openaiFrame("[DONE]");

    const events = await parseOpenAiStream(stream, Infinity, "reasoning_content");
    expect(events[1]).toEqual({ type: "reasoning_start", index: 0 });
    expect(events[2]).toEqual({ type: "reasoning_delta", index: 0, text: "chain" });
    // reasoning closes before text starts so the Anthropic renderer stays
    // sequential (GAP-001 / 6.3).
    expect(events[3]).toEqual({ type: "reasoning_end", index: 0 });
    expect(events[4]).toEqual({ type: "text_start", index: 0 });
    expect(events[5]).toEqual({ type: "text_delta", index: 0, text: "answer" });
    expect(events[6]).toEqual({ type: "text_end", index: 0 });

    // Without a declared field the reasoning text is not guessed.
    const undeclared = await parseOpenAiStream(stream);
    expect(undeclared.some((e) => e.type === "reasoning_start")).toBe(false);
  });

  it("emits usage and tolerates [DONE] (SR-010)", async () => {
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) +
      openaiFrame("[DONE]");

    const events = await parseOpenAiStream(stream);
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({ type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } });
  });
});

describe("canonical -> Anthropic SSE (source render)", () => {
  const textEvents: CanonicalStreamEvent[] = [
    { type: "message_start", id: "msg_1", model: "claude" },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "Hello" },
    { type: "text_delta", index: 0, text: " world" },
    { type: "text_end", index: 0 },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
    { type: "message_end", finishReason: "end_turn" },
  ];

  it("renders the official Anthropic event sequence", async () => {
    const frames = await renderAnthropicFrames(textEvents);
    const byEvent = Object.fromEntries(frames.map((f) => [f.event, JSON.parse(f.data)]));
    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(byEvent.message_start.message.id).toBe("msg_1");
    expect(byEvent.message_start.message.type).toBe("message");
    expect(byEvent["content_block_start"]).toMatchObject({
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(byEvent["content_block_delta"]).toMatchObject({
      index: 0,
      delta: { type: "text_delta", text: " world" },
    });
    // usage is folded into the single terminal message_delta
    expect(byEvent.message_delta).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });

  it("renders tool and reasoning blocks with remapped global indexes", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "checking" },
      { type: "reasoning_start", index: 0, metadata: { type: "thinking", signature: "s0" } },
      { type: "reasoning_delta", index: 0, text: "think" },
      { type: "reasoning_delta", index: 0, opaque: "s1" },
      { type: "reasoning_end", index: 0 },
      { type: "tool_start", index: 0, id: "toolu_1", name: "get_weather" },
      { type: "tool_arguments_delta", index: 0, partialJson: '{"city":"Paris"}' },
      { type: "tool_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ]);
    const starts = frames.filter((f) => f.event === "content_block_start").map((f) => JSON.parse(f.data));
    expect(starts).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "", signature: "s0" },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      },
    ]);
    const sigDelta = frames.find(
      (f) => f.event === "content_block_delta" && JSON.parse(f.data).delta.type === "signature_delta",
    );
    expect(JSON.parse(sigDelta!.data)).toMatchObject({
      index: 1,
      delta: { type: "signature_delta", signature: "s1" },
    });
    const last = frames[frames.length - 2];
    expect(last.event).toBe("message_delta");
    expect(JSON.parse(last.data).delta.stop_reason).toBe("tool_use");
  });

  it("ends with message_stop on flush", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "text_end", index: 0 },
    ]);
    expect(frames[frames.length - 1]).toEqual({ event: "message_stop", data: '{"type":"message_stop"}', id: undefined });
  });
});

describe("canonical -> OpenAI SSE (source render)", () => {
  it("renders text chunks, finish_reason and [DONE]", async () => {
    const frames = await renderOpenAiFrames([
      { type: "message_start", id: "msg_1", model: "claude" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Hello" },
      { type: "text_delta", index: 0, text: " world" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(frames[frames.length - 1]).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].choices[0].delta.content).toBe(" world");
    expect(chunks[3].choices[0].finish_reason).toBe("stop");
  });

  it("renders tool_calls with positional mapping and incremental arguments", async () => {
    const frames = await renderOpenAiFrames([
      { type: "message_start" },
      { type: "tool_start", index: 2, id: "toolu_1", name: "get_weather" },
      { type: "tool_arguments_delta", index: 2, partialJson: '{"city"' },
      { type: "tool_arguments_delta", index: 2, partialJson: ':"Paris"}' },
      { type: "tool_end", index: 2 },
      { type: "message_end", finishReason: "tool_call" },
    ]);
    const chunks = frames.slice(0, -1).map((d) => JSON.parse(d));
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const start = toolChunks[0].choices[0].delta.tool_calls[0];
    expect(start).toEqual({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    const args = toolChunks
      .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
      .join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(JSON.parse(args)).toEqual({ city: "Paris" }); // SR-003
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("renders reasoning into the declared field", async () => {
    const frames = await renderOpenAiFrames(
      [
        { type: "message_start" },
        { type: "reasoning_start", index: 0 },
        { type: "reasoning_delta", index: 0, text: "chain" },
        { type: "text_delta", index: 0, text: "answer" },
        { type: "message_end", finishReason: "end_turn" },
      ],
      "reasoning_content",
    );
    const chunks = frames.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.some((c) => c.choices[0].delta.reasoning_content === "chain")).toBe(true);
  });

  it("emits an error chunk then [DONE] (SR-006)", async () => {
    const frames = await renderOpenAiFrames([
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "partial" },
      { type: "error", error: { kind: "stream_protocol", message: "boom" } },
    ]);
    expect(frames[frames.length - 1]).toBe("[DONE]");
    const errorChunk = JSON.parse(frames[frames.length - 2]);
    expect(errorChunk.error.message).toBe("boom");
  });

  it("emits usage in the terminal chunk when it precedes message_end", async () => {
    const frames = await renderOpenAiFrames([
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const chunks = frames.slice(0, -1).map((d) => JSON.parse(d));
    const last = chunks[chunks.length - 1];
    expect(last.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3 });
    expect(last.choices[0].finish_reason).toBe("stop");
  });

  it("drops an opaque thinking signature with a warning when no field is declared (P1-2)", async () => {
    const warnings: TranslationWarning[] = [];
    const profile = {
      ...openaiChatDefaultProfile,
      capabilities: {
        ...openaiChatDefaultProfile.capabilities,
        reasoningField: "reasoning_content",
      },
    };
    const bytes = new ReadableStream<CanonicalStreamEvent>({
      start(c) {
        for (const e of [
          { type: "message_start" } as const,
          { type: "reasoning_start", index: 0 } as const,
          { type: "reasoning_delta", index: 0, opaque: "SIG-1" } as const,
          { type: "reasoning_end", index: 0 } as const,
          { type: "message_end", finishReason: "end_turn" } as const,
        ]) c.enqueue(e);
        c.close();
      },
    }).pipeThrough(createOpenAiChatStreamRenderer(profile, DEFAULT_POLICIES, (w) => warnings.push(w)));
    await collect(bytes.pipeThrough(createSSEParser()));
    const sig = warnings.find((w) => w.code === "thinking_signature_dropped");
    expect(sig).toBeTruthy();
    expect(sig!.fidelity).toBe("LOSSY");
  });

  it("emits an opaque thinking signature to the declared provider field (P1-2)", async () => {
    const profile = {
      ...openaiChatDefaultProfile,
      capabilities: {
        ...openaiChatDefaultProfile.capabilities,
        reasoningField: "reasoning_content",
        reasoning: { text: true, opaqueSignature: true, signatureField: "thinking_signature" },
      },
    };
    const bytes = new ReadableStream<CanonicalStreamEvent>({
      start(c) {
        for (const e of [
          { type: "message_start" } as const,
          { type: "reasoning_start", index: 0 } as const,
          { type: "reasoning_delta", index: 0, opaque: "SIG-1" } as const,
          { type: "reasoning_end", index: 0 } as const,
          { type: "message_end", finishReason: "end_turn" } as const,
        ]) c.enqueue(e);
        c.close();
      },
    }).pipeThrough(createOpenAiChatStreamRenderer(profile));
    const frames = await collect(bytes.pipeThrough(createSSEParser()));
    const chunks = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data));
    const sigChunk = chunks.find(
      (c) => c.choices?.[0]?.delta?.thinking_signature === "SIG-1",
    );
    expect(sigChunk).toBeTruthy();
  });
});
