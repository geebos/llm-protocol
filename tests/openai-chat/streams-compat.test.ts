/**
 * OpenAI Chat stream parser compatibility fixtures (STREAM-001 .. STREAM-010,
 * GAP-014). Source protocol: openai-chat.
 *
 * Hardened OpenAI Chat parser behavior: block phase transitions, tool-fragment
 * accumulation in arbitrary order, finish/late-usage separation, EOF/DONE
 * finalize, mid-stream errors and provider dialect declarations.
 */
import { describe, expect, it } from "vitest";
import {
  createCanonicalValidator,
  createOpenAiChatStreamParser,
  createSSEParser,
  type CanonicalStreamEvent,
  type SSEFrame,
} from "../../src/streams/index.js";
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";
import type { TranslationWarning } from "../../src/ir/fidelity.js";

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
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function reasoningProfile() {
  return {
    ...openaiChatDefaultProfile,
    capabilities: {
      ...openaiChatDefaultProfile.capabilities,
      reasoningField: "reasoning_content",
    },
  };
}

interface ParseResult {
  events: CanonicalStreamEvent[];
  frames: SSEFrame[];
  warnings: TranslationWarning[];
}

async function parseOpenAi(
  text: string,
  opts: { reasoning?: boolean; validate?: boolean } = {},
): Promise<ParseResult> {
  const warnings: TranslationWarning[] = [];
  const profile = opts.reasoning ? reasoningProfile() : openaiChatDefaultProfile;
  let stream: ReadableStream<CanonicalStreamEvent> = bytesStream(text)
    .pipeThrough(createSSEParser())
    .pipeThrough(createOpenAiChatStreamParser(profile, (w) => warnings.push(w)));
  if (opts.validate) {
    stream = stream.pipeThrough(createCanonicalValidator());
  }
  const frames = await collect(bytesStream(text).pipeThrough(createSSEParser()));
  return { events: await collect(stream), frames, warnings };
}

function hasError(events: CanonicalStreamEvent[]): boolean {
  return events.some((e) => e.type === "error");
}

{
  it("closes the reasoning block before starting text (GAP-001)", async () => {
    const { events } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "r1" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { reasoning_content: "r2" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "t1" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "t2" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        openaiFrame("[DONE]"),
      { reasoning: true },
    );

    const types = events.map((e) => e.type);
    // reasoning fully paired before text begins
    const ri = types.indexOf("reasoning_start");
    expect(types.slice(ri)).toEqual([
      "reasoning_start",
      "reasoning_delta",
      "reasoning_delta",
      "reasoning_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "message_end",
    ]);
    expect(events[events.length - 1]).toMatchObject({
      type: "message_end",
      finishReason: "end_turn",
    });
  });
}

{
  it("stops thinking before the tool block starts", async () => {
    const { events } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "think" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        openaiFrame("[DONE]"),
      { reasoning: true },
    );

    const reasoningEnd = events.findIndex((e) => e.type === "reasoning_end");
    const toolStart = events.findIndex((e) => e.type === "tool_start");
    expect(reasoningEnd).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(reasoningEnd);
    expect(events[events.length - 1]).toMatchObject({
      type: "message_end",
      finishReason: "tool_call",
    });
  });
}

{
  it("emits tool_start only once with the real name (id -> name -> args)", async () => {
    const { events } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1" }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "get_weather" } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        openaiFrame("[DONE]"),
    );

    const start = events.find((e) => e.type === "tool_start");
    // no placeholder name: the deferred start uses the real name
    expect(start).toEqual({ type: "tool_start", index: 0, id: "call_1", name: "get_weather" });
    const starts = events.filter((e) => e.type === "tool_start");
    expect(starts).toHaveLength(1);
    const args = events
      .filter((e) => e.type === "tool_arguments_delta")
      .map((e) => (e as { partialJson: string }).partialJson)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });
  });
}

{
  it("buffers arguments until tool_start without a validator error", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_weather" } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const args = events
      .filter((e) => e.type === "tool_arguments_delta")
      .map((e) => (e as { partialJson: string }).partialJson)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });
    expect(warnings.some((w) => w.code === "tool_metadata_deferred")).toBe(true);
  });
}

{
  it("does not terminal on finish_reason; preserves late usage", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        openaiFrame({ id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const usageIdx = events.findIndex((e) => e.type === "usage");
    const endIdx = events.findIndex((e) => e.type === "message_end");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(usageIdx);
    expect(events[usageIdx]).toEqual({
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
    expect(warnings.some((w) => w.code === "late_usage")).toBe(true);
    expect(warnings.some((w) => w.code === "stream_closed_without_done")).toBe(false);
  });
}

{
  it("finalizes open blocks on EOF and reports abnormal close", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }] }),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain("text_end");
    expect(types).toContain("message_end");
    expect(events[events.length - 1].type).toBe("message_end");
    expect(warnings.some((w) => w.code === "stream_closed_without_done")).toBe(true);
    expect(warnings.some((w) => w.code === "stream_closed_without_finish")).toBe(true);
  });
}

{
  it("does not lose arguments; synthesizes the name on finalize", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1" }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const start = events.find((e) => e.type === "tool_start") as
      | { type: "tool_start"; index: number; id: string; name: string }
      | undefined;
    expect(start?.name).toBe("tool_0");
    const args = events
      .filter((e) => e.type === "tool_arguments_delta")
      .map((e) => (e as { partialJson: string }).partialJson)
      .join("");
    expect(args).toBe('{"q":"x"}');
    expect(warnings.some((w) => w.code === "missing_tool_name")).toBe(true);
  });
}

{
  it("keeps per-index accumulators independent", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "get_weather", arguments: "" } }, { index: 1, id: "b", function: { name: "get_time", arguments: "" } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }, { index: 1, function: { arguments: '{"tz":' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }, { index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const byIndex = new Map<number, string>();
    for (const e of events) {
      if (e.type === "tool_arguments_delta") {
        byIndex.set(e.index, (byIndex.get(e.index) ?? "") + e.partialJson);
      }
    }
    expect(JSON.parse(byIndex.get(0)!)).toEqual({ city: "Paris" });
    expect(JSON.parse(byIndex.get(1)!)).toEqual({ tz: "UTC" });
    const starts = events.filter((e) => e.type === "tool_start");
    expect(starts).toHaveLength(2);
    expect(warnings.some((w) => w.code === "synthesized_tool_id")).toBe(false);
  });
}

{
  it("stays legal when usage precedes finish_reason", async () => {
    const { events, warnings } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    expect(hasError(events)).toBe(false);
    const usageIdx = events.findIndex((e) => e.type === "usage");
    const endIdx = events.findIndex((e) => e.type === "message_end");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(usageIdx);
    expect(warnings.some((w) => w.code === "late_usage")).toBe(false);
  });
}

{
  it("stops business output and emits a single terminal error", async () => {
    const { events } = await parseOpenAi(
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] }) +
        openaiFrame({ id: "c", error: { message: "boom", type: "server_error" } }) +
        openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "late" }, finish_reason: null }] }) +
        openaiFrame("[DONE]"),
      { validate: true },
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: { message: string } }).error.message).toBe("boom");
    // no business events (and no duplicate terminal) after the error
    const errIdx = events.findIndex((e) => e.type === "error");
    const after = events.slice(errIdx + 1);
    expect(after.some((e) => e.type === "text_delta" || e.type === "message_end")).toBe(false);
  });
}

{
  function profileWith(caps: Record<string, unknown>) {
    return {
      ...openaiChatDefaultProfile,
      capabilities: { ...openaiChatDefaultProfile.capabilities, ...caps },
    };
  }

  it("does not warn about missing [DONE] when the provider declares no done marker", async () => {
    const warnings: TranslationWarning[] = [];
    const profile = profileWith({
      stream: { doneMarker: false },
    });
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const frames = await collect(
      bytesStream(stream)
        .pipeThrough(createSSEParser())
        .pipeThrough(createOpenAiChatStreamParser(profile, (w) => warnings.push(w))),
    );
    expect(frames[frames.length - 1].type).toBe("message_end");
    expect(warnings.some((w) => w.code === "stream_closed_without_done")).toBe(false);
    // no finish marker either still warns
    expect(warnings.some((w) => w.code === "stream_closed_without_finish")).toBe(false);
  });

  it("does not warn about late usage when the provider declares usageAfterFinish", async () => {
    const warnings: TranslationWarning[] = [];
    const profile = profileWith({
      usage: { usageAfterFinish: true },
    });
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openaiFrame({ id: "c", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
      openaiFrame("[DONE]");
    await collect(
      bytesStream(stream)
        .pipeThrough(createSSEParser())
        .pipeThrough(createOpenAiChatStreamParser(profile, (w) => warnings.push(w))),
    );
    expect(warnings.some((w) => w.code === "late_usage")).toBe(false);
  });

  it("does not warn about split tool metadata when the provider declares maySplitToolMetadata", async () => {
    const warnings: TranslationWarning[] = [];
    const profile = profileWith({
      stream: { maySplitToolMetadata: true },
    });
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1}" } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo" } }] }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      openaiFrame("[DONE]");
    await collect(
      bytesStream(stream)
        .pipeThrough(createSSEParser())
        .pipeThrough(createOpenAiChatStreamParser(profile, (w) => warnings.push(w))),
    );
    expect(warnings.some((w) => w.code === "tool_metadata_deferred")).toBe(false);
  });

  it("reads provider-specific cache-creation fields when the dialect is declared", async () => {
    const profile = profileWith({
      usage: { cacheCreation: true },
    });
    const stream =
      openaiFrame({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] }) +
      openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cache_write_tokens: 4 } }) +
      openaiFrame("[DONE]");
    const events = await collect(
      bytesStream(stream)
        .pipeThrough(createSSEParser())
        .pipeThrough(createOpenAiChatStreamParser(profile)),
    );
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 2, cacheCreationTokens: 4 },
    });
  });
}
