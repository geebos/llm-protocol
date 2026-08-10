/**
 * Canonical stream invariant validator tests (SR-002, 7.2).
 *
 * Enforces message_start/end pairing, block start/delta/end pairing, single
 * terminal transitions, and (review P0-4) that message_end never passes with
 * an unclosed block. Protocol-agnostic infrastructure.
 */
import { describe, expect, it } from "vitest";
import { createCanonicalValidator } from "../src/streams/index.js";
import type { CanonicalStreamEvent } from "../src/streams/types.js";

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

{
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

  it("rejects message_end with an unclosed block (review P0-4)", async () => {
    const events = await validate([
      { type: "message_start", id: "m" },
      { type: "reasoning_start", index: 0 },
      // reasoning_end is missing: the terminal must not pass silently
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") {
      expect(err.error.message).toContain("unclosed block");
    }
  });

  it("passes a fully closed reasoning block through unchanged", async () => {
    const events = await validate([
      { type: "message_start", id: "m" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_delta", index: 0, text: "deep" },
      { type: "reasoning_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(events.every((e) => e.type !== "error")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "message_end" });
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
}

{
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
}
