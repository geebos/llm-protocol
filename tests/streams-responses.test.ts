/**
 * Responses stream state machine tests (responses.md §13, §16 matrix, D-7).
 *
 * Verifies the dual-lifecycle model (item lifecycle + content lifecycle),
 * lazy-open reasoning parts, terminal event selection (completed/incomplete/
 * failed exactly once), response_state round-trip, and the envelope snapshot
 * consistency across the stream.
 */
import { describe, expect, it } from "vitest";
import {
  createSSEParser,
  createResponsesStreamParser,
  createResponsesStreamRenderer,
  type SSEFrame,
  type CanonicalStreamEvent,
} from "../src/streams/index.js";
import { openaiResponsesDefaultProfile } from "../src/codecs/openai-responses/index.js";
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

function bytesStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sse(...events: unknown[]): string {
  return events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
}

async function parseResponses(
  events: unknown[],
  report?: (w: TranslationWarning) => void,
): Promise<CanonicalStreamEvent[]> {
  return collect(
    bytesStream(sse(...events))
      .pipeThrough(createSSEParser())
      .pipeThrough(createResponsesStreamParser(openaiResponsesDefaultProfile, report)),
  );
}

interface WireEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

async function renderResponses(
  events: CanonicalStreamEvent[],
  report?: (w: TranslationWarning) => void,
): Promise<WireEvent[]> {
  const out = await collect(
    new ReadableStream<CanonicalStreamEvent>({
      start(controller) {
        for (const e of events) controller.enqueue(e);
        controller.close();
      },
    }).pipeThrough(createResponsesStreamRenderer(openaiResponsesDefaultProfile, report)),
  );
  const text = out.map((b) => new TextDecoder().decode(b)).join("");
  const frames: WireEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      frames.push(JSON.parse(line.slice(6)));
    }
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/* parse direction (§13.3)                                            */
/* ------------------------------------------------------------------ */

describe("responses stream parse", () => {
  it("emits one message_start for the first lifecycle event, response_state after (P1-1)", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "resp_1", model: "gpt-4o" } },
      { type: "response.queued", response: { id: "resp_1" } },
      { type: "response.in_progress", response: { id: "resp_1" } },
    ]);
    expect(events.filter((e) => e.type === "message_start")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message_start", id: "resp_1", model: "gpt-4o" });
    // lifecycle continuation + EOF-synthesized message_end (SR-002)
    expect(events.slice(1, 3)).toEqual([
      { type: "response_state", state: "queued" },
      { type: "response_state", state: "in_progress" },
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: "message_end" });
  });

  it("does NOT emit text_start on output_item.added(message); only on content_part.added (P0-3)", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hi" },
      { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hi" },
      { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: {} },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "text_start",
      "text_delta",
      "text_end",
      "message_end",
    ]);
  });

  it("parses function_call items into tool events with kind=function", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", name: "get_weather", call_id: "call_1", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"city\":" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"city\":\"Paris\"}" },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events).toContainEqual({
      type: "tool_start",
      index: 0,
      id: "call_1",
      name: "get_weather",
      kind: "function",
      location: { kind: "output", outputIndex: 0 },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_arguments_delta", index: 0, partialJson: "{\"city\":" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", index: 0 }));
    expect(events.filter((e) => e.type === "message_end")).toHaveLength(1);
  });

  it("parses custom_tool_call items with kind=custom (P0-1)", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "ctc_1", type: "custom_tool_call", name: "my_tool", call_id: "call_2", input: "" },
      },
      { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 0, delta: "free " },
      { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 0, input: "free text" },
      { type: "response.output_item.done", output_index: 0, item: { id: "ctc_1", type: "custom_tool_call" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", index: 0, id: "call_2", name: "my_tool", kind: "custom" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_arguments_delta", index: 0, partialJson: "free " }));
  });

  it("maps reasoning summary/text parts to kind=summary / kind=text deltas (P0-3)", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [], content: [] },
      },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0, part: {} },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "brief" },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", output_index: 0, summary_index: 0, text: "brief" },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0, summary_index: 0, part: {} },
      {
        type: "response.content_part.added",
        item_id: "rs_1",
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      },
      { type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 0, content_index: 0, delta: "deep" },
      { type: "response.reasoning_text.done", item_id: "rs_1", output_index: 0, content_index: 0, text: "deep" },
      { type: "response.content_part.done", item_id: "rs_1", output_index: 0, content_index: 0, part: {} },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning_start", index: 0 }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "reasoning_delta", kind: "summary", summaryIndex: 0, text: "brief" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "reasoning_delta", kind: "text", text: "deep" }),
    );
  });

  it("selects terminal events: completed/incomplete/failed exactly once (P0-1)", async () => {
    const completed = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(completed[completed.length - 1]).toMatchObject({ type: "message_end", finishReason: "end_turn" });

    const incomplete = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      { type: "response.incomplete", response: { id: "r", status: "incomplete", output: [] } },
    ]);
    expect(incomplete[incomplete.length - 1]).toMatchObject({ type: "message_end", finishReason: "max_tokens" });

    const failed = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      { type: "response.failed", response: { id: "r", status: "failed", error: { message: "boom" } } },
    ]);
    expect(failed[failed.length - 1]).toMatchObject({ type: "error" });
  });

  it("keeps refusal deltas as kind=refusal text events (P0-2)", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "refusal", refusal: "" },
      },
      { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "No" },
      { type: "response.refusal.done", item_id: "msg_1", output_index: 0, content_index: 0, refusal: "No" },
      { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: {} },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_start", kind: "refusal", index: 0 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", kind: "refusal", text: "No" }));
  });
});

/* ------------------------------------------------------------------ */
/* render direction (§13.2)                                           */
/* ------------------------------------------------------------------ */

describe("responses stream render", () => {
  it("renders message_start as created -> queued -> in_progress lifecycle", async () => {
    const frames = await renderResponses([
      { type: "message_start", id: "resp_native", model: "gpt-4o" },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(frames.slice(0, 3).map((f) => f.type)).toEqual([
      "response.created",
      "response.queued",
      "response.in_progress",
    ]);
    expect(frames[0].response).toMatchObject({ id: "resp_native", object: "response", model: "gpt-4o", status: "queued" });
    // sequence numbers strictly increase
    const seqs = frames.map((f) => f.sequence_number as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("renders text with the item/content dual lifecycle (P0-3)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Hello" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const types = frames.map((f) => f.type);
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    const delta = frames.find((f) => f.type === "response.output_text.delta");
    expect(delta?.delta).toBe("Hello");
    // envelope snapshot on the terminal event carries the item (P0-3)
    const completed = frames.find((f) => f.type === "response.completed");
    const output = completed?.response?.output as Array<Record<string, unknown>> | undefined;
    expect(output?.[0]).toMatchObject({ type: "message", status: "completed" });
  });

  it("renders tool events with kind-specific deltas (P0-1)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "tool_start", index: 0, id: "call_1", name: "get_weather", kind: "custom" },
      { type: "tool_arguments_delta", index: 0, partialJson: "free text" },
      { type: "tool_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ]);
    const types = frames.map((f) => f.type);
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.custom_tool_call_input.delta");
    expect(types).toContain("response.custom_tool_call_input.done");
    const added = frames.find((f) => f.type === "response.output_item.added");
    expect(added?.item).toMatchObject({ type: "custom_tool_call", name: "get_weather", call_id: "call_1" });
  });

  it("aggregates adjacent text blocks into one message item", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "a" },
      { type: "text_end", index: 0 },
      { type: "text_start", index: 1 },
      { type: "text_delta", index: 1, text: "b" },
      { type: "text_end", index: 1 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const adds = frames.filter((f) => f.type === "response.output_item.added");
    expect(adds).toHaveLength(1);
    const parts = frames.filter((f) => f.type === "response.content_part.added");
    expect(parts).toHaveLength(2);
  });

  it("renders reasoning with lazy summary/text part opening (P0-3)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_delta", index: 0, text: "brief", kind: "summary", summaryIndex: 0 },
      { type: "reasoning_delta", index: 0, text: "deep", kind: "text" },
      { type: "reasoning_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const types = frames.map((f) => f.type);
    expect(types).toContain("response.reasoning_summary_part.added");
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.reasoning_summary_text.done");
    expect(types).toContain("response.reasoning_summary_part.done");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.reasoning_text.delta");
    expect(types).toContain("response.reasoning_text.done");
    expect(types).toContain("response.content_part.done");
    const done = frames.find((f) => f.type === "response.output_item.done");
    expect(done?.item).toMatchObject({ type: "reasoning", status: "completed" });
  });

  it("does not fabricate summary parts when only reasoning text arrives (lazy open)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_delta", index: 0, text: "only text", kind: "text" },
      { type: "reasoning_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    expect(frames.some((f) => f.type === "response.reasoning_summary_part.added")).toBe(false);
  });

  it("chooses response.incomplete for max_tokens, exactly once (P0-1)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "cut" },
      { type: "text_end", index: 0 },
      { type: "message_end", finishReason: "max_tokens" },
    ]);
    const incomplete = frames.filter((f) => f.type === "response.incomplete");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].response).toMatchObject({ status: "incomplete" });
    expect(incomplete[0].response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(frames.some((f) => f.type === "response.completed")).toBe(false);
  });

  it("folds usage into the terminal envelope once (SR-010)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const completed = frames.find((f) => f.type === "response.completed");
    expect(completed?.response?.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it("emits response.failed for an error event after start (SR-006)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "error", error: { kind: "upstream", message: "boom" } },
    ]);
    const failed = frames.filter((f) => f.type === "response.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].response).toMatchObject({ status: "failed" });
  });

  it("renders refusal parts as refusal content parts (P0-2)", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "text_start", index: 0, kind: "refusal" },
      { type: "text_delta", index: 0, text: "No", kind: "refusal" },
      { type: "text_end", index: 0, kind: "refusal" },
      { type: "message_end", finishReason: "refusal" },
    ]);
    const added = frames.find((f) => f.type === "response.content_part.added");
    expect(added?.part).toMatchObject({ type: "refusal" });
    expect(frames.some((f) => f.type === "response.refusal.delta")).toBe(true);
  });
});
