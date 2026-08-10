/**
 * Anthropic Messages SSE state machine tests.
 *
 * Source protocol: anthropic-messages. Target parse (Anthropic SSE ->
 * canonical) and source render (canonical -> Anthropic SSE), plus renderer
 * edges, keepalive pings and error events.
 */
import { describe, expect, it } from "vitest";
import {
  createSSEParser,
  createAnthropicStreamParser,
  createAnthropicStreamRenderer,
  withAnthropicKeepAlive,
  type SSEFrame,
  type CanonicalStreamEvent,
} from "../../src/streams/index.js";

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

function eventsToBytes(events: CanonicalStreamEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  }).pipeThrough(createAnthropicStreamRenderer());
}

async function renderAnthropicFrames(
  events: CanonicalStreamEvent[],
): Promise<SSEFrame[]> {
  return collect(eventsToBytes(events).pipeThrough(createSSEParser()));
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

{
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
}

{
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
}

{
  it("maps redacted_thinking to reasoning_start with opaque metadata", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", content: [] } }) +
      anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "REDACTED-BASE64" } }) +
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      anthropicFrame("message_stop", { type: "message_stop" });

    const events = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(stream));
          c.close();
        },
      })
        .pipeThrough(createSSEParser())
        .pipeThrough(createAnthropicStreamParser()),
    );
    expect(events[1]).toMatchObject({
      type: "reasoning_start",
      metadata: { type: "redacted_thinking", data: "REDACTED-BASE64" },
    });
  });
}

{
  it("maps content_filter to end_turn", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "x" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "content_filter" },
    ]);
    const messageDelta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(messageDelta!.data).delta.stop_reason).toBe("end_turn");
  });

  it("flushes a trailing usage with a null stop_reason when no message_end arrives", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "x" },
      { type: "text_end", index: 0 },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const messageDelta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(messageDelta!.data)).toMatchObject({
      delta: { stop_reason: null },
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(frames[frames.length - 1].event).toBe("message_stop");
  });
}

{
  it("falls back when an in-stream error lacks a message", async () => {
    const stream =
      anthropicFrame("message_start", { type: "message_start", message: { id: "m", content: [] } }) +
      anthropicFrame("error", { type: "error", error: { type: "api_error" } });
    const events = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(stream));
          c.close();
        },
      })
        .pipeThrough(createSSEParser())
        .pipeThrough(createAnthropicStreamParser()),
    );
    const err = events[1];
    expect(err.type).toBe("error");
    expect((err as { error: { message: string } }).error.message).toBe("upstream stream error");
  });

  it("renders an empty-usage message_delta with zeroed structure (Anthropic SDK requirement)", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const messageDelta = frames.find((f) => f.event === "message_delta");
    expect(JSON.parse(messageDelta!.data)).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
}

{
  it("emits an error event and suppresses later business events", async () => {
    const frames = await renderAnthropicFrames([
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "partial" },
      { type: "error", error: { kind: "stream_protocol", message: "boom" } },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(frames.find((f) => f.event === "error")).toBeTruthy();
    // no message_delta after the error
    const errorIdx = frames.findIndex((f) => f.event === "error");
    const after = frames.slice(errorIdx + 1);
    expect(after.every((f) => f.event === "message_stop" || f.event === "ping")).toBe(true);
    expect(frames[frames.length - 1].event).toBe("message_stop");
  });
}

{
  function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("injects ping frames while the upstream is idle", async () => {
    // Upstream emits one frame then goes quiet (like a long thinking stream).
    const upstream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'));
        // never closes during the test window
      },
    });
    const keepAlive = withAnthropicKeepAlive(upstream, 20);
    const reader = keepAlive.getReader();
    await reader.read(); // the real frame
    const frames: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { value } = await reader.read();
      frames.push(new TextDecoder().decode(value));
    }
    await reader.cancel();
    expect(frames.every((f) => f.includes('event: ping'))).toBe(true);
    expect(frames.every((f) => f.includes('{"type":"ping"}'))).toBe(true);
  });

  it("stops pinging and forwards EOF when the upstream closes", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: y\n\n'));
        c.close();
      },
    });
    const keepAlive = withAnthropicKeepAlive(upstream, 10);
    const reader = keepAlive.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: y\n\n');
    const second = await reader.read();
    expect(second.done).toBe(true);
    await delay(30); // let the timer fire; nothing more may be enqueued
    const after = await reader.read();
    expect(after.done).toBe(true);
  });

  it("forwards cancellation to the upstream (SR-008)", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const keepAlive = withAnthropicKeepAlive(upstream, 10);
    const reader = keepAlive.getReader();
    await reader.cancel();
    await delay(20);
    expect(cancelled).toBe(true);
  });
}
