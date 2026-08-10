/**
 * OpenAI Chat SSE state machine tests.
 *
 * Source protocol: openai-chat. Target parse (OpenAI SSE -> canonical) and
 * source render (canonical -> OpenAI SSE), plus renderer late-usage and parser
 * tool index/usage edges.
 */
import { describe, expect, it } from "vitest";
import {
  createSSEParser,
  createOpenAiChatStreamParser,
  createOpenAiChatStreamRenderer,
  type SSEFrame,
  type CanonicalStreamEvent,
} from "../../src/streams/index.js";
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";
import { DEFAULT_POLICIES } from "../../src/ir/policies.js";
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

async function renderOpenAiFrames(
  events: CanonicalStreamEvent[],
  reasoningField?: string,
): Promise<string[]> {
  const profile = {
    ...openaiChatDefaultProfile,
    capabilities: {
      ...openaiChatDefaultProfile.capabilities,
      ...(reasoningField ? { reasoningField } : {}),
    },
  };
  const bytes = new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  }).pipeThrough(createOpenAiChatStreamRenderer(profile));
  const parser = createSSEParser();
  const frames = await collect(bytes.pipeThrough(parser));
  return frames.map((f) => f.data);
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

{
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
}

{
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
}

{
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
}

{
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
}
