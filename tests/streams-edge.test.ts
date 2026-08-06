/**
 * M2 edge-case tests: validator invariants (SR-002), redacted thinking,
 * content_filter mapping, late usage, unknown events.
 */
import { describe, expect, it } from "vitest";
import {
  createCanonicalValidator,
  createAnthropicStreamParser,
  createAnthropicStreamRenderer,
  createOpenAiChatStreamParser,
  createOpenAiChatStreamRenderer,
  createSSEParser,
  type CanonicalStreamEvent,
  type SSEFrame,
} from "../src/streams/index.js";
import { openaiChatDefaultProfile } from "../src/codecs/openai-chat/index.js";

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

async function validate(events: CanonicalStreamEvent[]): Promise<CanonicalStreamEvent[]> {
  return collect(
    new ReadableStream<CanonicalStreamEvent>({
      start(c) {
        for (const e of events) c.enqueue(e);
        c.close();
      },
    }).pipeThrough(createCanonicalValidator()),
  );
}

async function renderAnthropicFrames(
  events: CanonicalStreamEvent[],
): Promise<SSEFrame[]> {
  return collect(
    new ReadableStream<CanonicalStreamEvent>({
      start(c) {
        for (const e of events) c.enqueue(e);
        c.close();
      },
    })
      .pipeThrough(createAnthropicStreamRenderer())
      .pipeThrough(createSSEParser()),
  );
}

async function renderOpenAiFrames(events: CanonicalStreamEvent[]): Promise<string[]> {
  return collect(
    new ReadableStream<CanonicalStreamEvent>({
      start(c) {
        for (const e of events) c.enqueue(e);
        c.close();
      },
    })
      .pipeThrough(createOpenAiChatStreamRenderer(openaiChatDefaultProfile))
      .pipeThrough(createSSEParser()),
  ).then((frames) => frames.map((f) => f.data));
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("canonical validator invariants (SR-002, 7.2)", () => {
  it("rejects a delta before message_start", async () => {
    const out = await validate([{ type: "text_delta", index: 0, text: "x" }]);
    expect(out[0].type).toBe("error");
    expect((out[0] as { error: { kind: string } }).error.kind).toBe("stream_protocol");
  });

  it("rejects duplicate message_start", async () => {
    const out = await validate([
      { type: "message_start" },
      { type: "message_start" },
    ]);
    expect(out[1].type).toBe("error");
  });

  it("rejects a delta for an unstarted block", async () => {
    const out = await validate([
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "x" },
    ]);
    expect(out[1].type).toBe("error");
  });

  it("rejects a duplicate end and events after message_end", async () => {
    const out = await validate([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_end", index: 0 },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
      { type: "text_start", index: 1 },
    ]);
    expect(out[3].type).toBe("error"); // duplicate end
    expect(out[5].type).toBe("error"); // event after message_end
  });

  it("passes through a valid stream unchanged", async () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ];
    const out = await validate(events);
    expect(out).toEqual(events);
  });
});

describe("Anthropic parser redacted thinking", () => {
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
});

describe("Anthropic renderer stop-reason and usage edges", () => {
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
});

describe("OpenAI renderer late usage", () => {
  it("emits a standalone usage chunk when usage arrives after message_end", async () => {
    const frames = await renderOpenAiFrames([
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "message_end", finishReason: "end_turn" },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
    const chunks = frames.slice(0, -1).map((d) => JSON.parse(d));
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk).toBeTruthy();
    expect((usageChunk.usage as Record<string, unknown>).prompt_tokens).toBe(4);
    expect(frames[frames.length - 1]).toBe("[DONE]");
  });
});

describe("SSE parser flush edges (SR-001)", () => {
  it("flushes a field-only frame at stream end (no data)", async () => {
    const out = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("id: 9\n\n"));
          c.close();
        },
      }).pipeThrough(createSSEParser()),
    );
    expect(out).toEqual([{ event: "message", data: "", id: "9" }]);
  });

  it("tolerates a trailing comment line at stream end", async () => {
    const out = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: x\n\n: trailing"));
          c.close();
        },
      }).pipeThrough(createSSEParser()),
    );
    expect(out).toEqual([{ event: "message", data: "x" }]);
  });
});

describe("validator end/delta guard edges (SR-002)", () => {
  it("rejects a delta after block end", async () => {
    const out = await validate([
      { type: "message_start" },
      { type: "text_start", index: 0 },
      { type: "text_end", index: 0 },
      { type: "text_delta", index: 0, text: "late" },
    ]);
    expect(out[3].type).toBe("error");
  });

  it("rejects an end for an unstarted block", async () => {
    const out = await validate([
      { type: "message_start" },
      { type: "text_end", index: 0 },
    ]);
    expect(out[1].type).toBe("error");
  });

  it("rejects usage before message_start", async () => {
    const out = await validate([
      { type: "usage", usage: { inputTokens: 1 } },
    ]);
    expect(out[0].type).toBe("error");
  });

  it("validates tool/reasoning block pairing and rejects start-after-end", async () => {
    const ok = await validate([
      { type: "message_start" },
      { type: "tool_start", index: 0, id: "t1", name: "echo" },
      { type: "tool_arguments_delta", index: 0, partialJson: "{}" },
      { type: "tool_end", index: 0 },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_delta", index: 0, text: "r" },
      { type: "reasoning_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(ok.every((e) => e.type !== "error")).toBe(true);

    const afterEnd = await validate([
      { type: "message_start" },
      { type: "message_end", finishReason: "end_turn" },
      { type: "tool_start", index: 0, id: "t1", name: "echo" },
    ]);
    expect(afterEnd[2].type).toBe("error");

    const dupStart = await validate([
      { type: "message_start" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_start", index: 0 },
    ]);
    expect(dupStart[2].type).toBe("error");

    const deltaAfterEnd = await validate([
      { type: "message_start" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_end", index: 0 },
      { type: "reasoning_delta", index: 0, text: "late" },
    ]);
    expect(deltaAfterEnd[3].type).toBe("error");
  });

  it("drops business events after a terminal error", async () => {
    const out = await validate([
      { type: "error", error: { kind: "upstream", message: "x" } },
      { type: "text_start", index: 0 },
    ]);
    expect(out[1].type).toBe("error");
  });
});

describe("Anthropic parse/render edges", () => {
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
});

describe("Anthropic renderer error event (SR-006)", () => {
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
});

describe("OpenAI parser tool index/usage edges", () => {
  it("parses a delta-only chunk before any role (some providers)", async () => {
    const stream =
      'data: {"id":"c","choices":[{"index":0,"delta":{"content":"no role first"},"finish_reason":null}]}\n\n' +
      'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const events = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(stream));
          c.close();
        },
      })
        .pipeThrough(createSSEParser())
        .pipeThrough(createOpenAiChatStreamParser(openaiChatDefaultProfile)),
    );
    expect(events[0].type).toBe("message_start");
    expect(events[1]).toEqual({ type: "text_start", index: 0 });
    expect(events[2]).toEqual({ type: "text_delta", index: 0, text: "no role first" });
    expect(events[3]).toEqual({ type: "text_end", index: 0 });
  });
});
