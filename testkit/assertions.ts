/**
 * Semantic assertions (10.5).
 *
 * Protocol-level invariants (event pairing, block indices) are enforced by the
 * core validator; these assertions verify the *meaning* of translated output:
 * text aggregation, tool identity/arguments, finish reasons, usage.
 */
import type { AssertionContext } from "./types.js";
import type { SSEFrame } from "../src/streams/index.js";

export interface ToolCallView {
  id: string;
  name: string;
  argumentsText: string;
}

export function fail(msg: string): never {
  throw new Error(`assertion failed: ${msg}`);
}

export function assertNonEmptyText(ctx: AssertionContext): void {
  if (ctx.streamText !== undefined) {
    if (!ctx.streamText.trim()) fail("streamed text is empty");
    return;
  }
  const text = extractText(ctx.responseBody);
  if (!text.trim()) fail("response text is empty");
}

export function assertFinishReason(
  ctx: AssertionContext,
  expected: string,
): void {
  const reason = extractFinishReason(ctx);
  if (reason !== expected) {
    fail(`finish reason ${JSON.stringify(reason)} != expected ${JSON.stringify(expected)}`);
  }
}

export function assertToolCall(
  ctx: AssertionContext,
  expectedName: string,
): ToolCallView {
  const calls = extractToolCalls(ctx);
  if (calls.length === 0) fail(`no tool call found (expected ${expectedName})`);
  const call = calls[0];
  if (call.name !== expectedName) {
    fail(`tool name ${JSON.stringify(call.name)} != expected ${JSON.stringify(expectedName)}`);
  }
  // TR-003: tool arguments must form valid JSON (non-streaming and streaming).
  try {
    JSON.parse(call.argumentsText);
  } catch {
    fail(`tool arguments are not valid JSON: ${call.argumentsText.slice(0, 120)}`);
  }
  return call;
}

/**
 * Assert at least `min` parallel tool calls, each with a distinct id/name and
 * valid-JSON arguments (tech-v2.md STREAM-008 / §20 Parallel Tool).
 */
export function assertParallelToolCalls(
  ctx: AssertionContext,
  min: number,
): ToolCallView[] {
  const calls = extractToolCalls(ctx);
  if (calls.length < min) {
    fail(`expected >= ${min} parallel tool calls, got ${calls.length}`);
  }
  const ids = new Set(calls.map((c) => c.id));
  if (ids.size !== calls.length) {
    fail(`parallel tool calls have duplicate ids: ${[...ids].join(",")}`);
  }
  for (const call of calls) {
    if (!call.id) fail("parallel tool call missing id");
    if (!call.name) fail(`parallel tool call ${call.id} missing name`);
    try {
      JSON.parse(call.argumentsText);
    } catch {
      fail(`tool arguments are not valid JSON: ${call.argumentsText.slice(0, 120)}`);
    }
  }
  return calls;
}

/**
 * Assert the stream carried reasoning deltas before any text (structure-only;
 * never asserts private reasoning content — tech-v2.md STREAM-001).
 */
export function assertReasoningThenText(ctx: AssertionContext): void {
  if (!ctx.streamFrames) fail("no stream frames to inspect for reasoning");
  const order: string[] = [];
  for (const f of ctx.streamFrames) {
    if (f.data === "[DONE]") continue;
    if (f.event === "message_start" || f.event === "content_block_start") {
      order.push("block_start");
      continue;
    }
    try {
      const data = JSON.parse(f.data) as Record<string, unknown>;
      if (f.event === "message_delta") {
        order.push("message_delta");
        continue;
      }
      const delta = (data.delta ?? {}) as Record<string, unknown>;
      const choiceDelta =
        ((data.choices as Array<Record<string, unknown>>)?.[0]?.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
        order.push("reasoning_delta");
      } else if (delta.type === "text_delta") {
        order.push("text_delta");
      }
      if (typeof choiceDelta.content === "string" && choiceDelta.content !== "") {
        order.push("text_delta");
      }
      if (
        typeof choiceDelta.reasoning_content === "string" &&
        choiceDelta.reasoning_content !== ""
      ) {
        order.push("reasoning_delta");
      }
    } catch {
      /* ignore non-JSON / DONE */
    }
  }
  const firstReasoning = order.indexOf("reasoning_delta");
  const firstText = order.indexOf("text_delta");
  if (firstReasoning === -1) {
    fail("no reasoning delta observed in stream");
  }
  if (firstText !== -1 && firstText < firstReasoning) {
    fail("text delta observed before any reasoning delta");
  }
}

export function assertUsagePresent(ctx: AssertionContext): void {
  const usage = extractUsage(ctx);
  if (!usage || typeof usage !== "object") fail("usage missing");
}

export function assertStreamEndsCleanly(ctx: AssertionContext): void {
  if (ctx.streamFrames === undefined) return;
  const frames = ctx.streamFrames;
  const last = frames[frames.length - 1];
  if (!last) fail("no stream frames");
  // OpenAI source: [DONE]; Anthropic source: message_stop.
  if (last.data === "[DONE]") return;
  if (last.event === "message_stop") return;
  fail(`stream does not end cleanly (last frame event=${last.event})`);
}

// ---- extractors (protocol aware, operate on the source-protocol response) ----

function extractText(body: unknown): string {
  const b = body as Record<string, unknown> | undefined;
  if (!b) return "";
  if (b.object === "chat.completion") {
    const msg = (b.choices as Array<Record<string, unknown>>)?.[0]?.message as
      | Record<string, unknown>
      | undefined;
    return typeof msg?.content === "string" ? msg.content : "";
  }
  if (b.type === "message") {
    const content = (b.content as Array<Record<string, unknown>>) ?? [];
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

function extractFinishReason(ctx: AssertionContext): string | undefined {
  if (ctx.streamFrames !== undefined) {
    // OpenAI source stream: finish_reason in the terminal chunk.
    const chunks = ctx.streamFrames
      .filter((f) => f.data !== "[DONE]" && f.data !== "{}")
      .map((f) => {
        try {
          return JSON.parse(f.data) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((c): c is Record<string, unknown> => c !== null);
    for (const c of chunks) {
      const fr = (c.choices as Array<Record<string, unknown>>)?.[0]?.finish_reason;
      if (typeof fr === "string") return fr;
    }
    // Anthropic source stream: message_delta.stop_reason.
    for (const f of ctx.streamFrames) {
      if (f.event === "message_delta") {
        try {
          return (JSON.parse(f.data) as { delta?: { stop_reason?: string } }).delta
            ?.stop_reason;
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }
  const b = ctx.responseBody as Record<string, unknown> | undefined;
  if (!b) return undefined;
  if (b.object === "chat.completion") {
    return (b.choices as Array<Record<string, unknown>>)?.[0]?.finish_reason as
      | string
      | undefined;
  }
  if (b.type === "message") return b.stop_reason as string | undefined;
  return undefined;
}

function extractToolCalls(ctx: AssertionContext): ToolCallView[] {
  const views: ToolCallView[] = [];
  if (ctx.streamFrames !== undefined) {
    // Detect which source protocol the frames carry.
    const isAnthropic = ctx.streamFrames.some(
      (f) => f.event === "message_start" || f.event === "content_block_start",
    );
    if (isAnthropic) {
      return extractAnthropicStreamToolCalls(ctx.streamFrames);
    }
    return extractOpenAiStreamToolCalls(ctx.streamFrames);
  }
  const b = ctx.responseBody as Record<string, unknown> | undefined;
  if (!b) return views;
  if (b.object === "chat.completion") {
    const msg = ((b.choices as Array<Record<string, unknown>>)?.[0]?.message ?? {}) as Record<string, unknown>;
    const tcs = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (tcs) {
      for (const tc of tcs) {
        const fn = tc.function as Record<string, unknown> | undefined;
        views.push({
          id: tc.id as string,
          name: fn?.name as string,
          argumentsText: (fn?.arguments as string) ?? "",
        });
      }
    }
    return views;
  }
  if (b.type === "message") {
    const content = (b.content as Array<Record<string, unknown>>) ?? [];
    for (const p of content) {
      if (p.type === "tool_use") {
        views.push({
          id: p.id as string,
          name: p.name as string,
          argumentsText: JSON.stringify(p.input ?? {}),
        });
      }
    }
  }
  return views;
}

/** Anthropic source stream: tool_use start + input_json_delta accumulation. */
function extractAnthropicStreamToolCalls(frames: SSEFrame[]): ToolCallView[] {
  const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
  for (const f of frames) {
    if (f.event === "content_block_start") {
      const data = JSON.parse(f.data) as {
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
      };
      if (data.content_block?.type !== "tool_use") continue;
      const index = data.index ?? 0;
      byIndex.set(index, {
        id: data.content_block.id,
        name: data.content_block.name,
        args: "",
      });
    } else if (f.event === "content_block_delta") {
      const data = JSON.parse(f.data) as {
        index?: number;
        delta?: { type?: string; partial_json?: string };
      };
      if (data.delta?.type !== "input_json_delta") continue;
      const index = data.index ?? 0;
      const state = byIndex.get(index);
      if (!state) continue;
      state.args += data.delta.partial_json ?? "";
    }
  }
  return [...byIndex.values()].map((s, i) => ({
    id: s.id ?? `toolu_${i}`,
    name: s.name ?? `tool_${i}`,
    argumentsText: s.args,
  }));
}

/** OpenAI source stream: delta.tool_calls accumulation by index. */
function extractOpenAiStreamToolCalls(frames: SSEFrame[]): ToolCallView[] {
  const views: ToolCallView[] = [];
  const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
  for (const f of frames) {
    if (f.data === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(f.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const delta = ((chunk.choices as Array<Record<string, unknown>>)?.[0]?.delta ?? {}) as Record<string, unknown>;
    const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!tcs) continue;
    for (const tc of tcs) {
      const index = tc.index as number;
      const state = byIndex.get(index) ?? { args: "" };
      if (typeof tc.id === "string") state.id = tc.id;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") state.name = fn.name;
      if (typeof fn?.arguments === "string") state.args += fn.arguments;
      byIndex.set(index, state);
    }
  }
  for (const [index, state] of byIndex) {
    views.push({
      id: state.id ?? `call_${index}`,
      name: state.name ?? `tool_${index}`,
      argumentsText: state.args,
    });
  }
  return views;
}

function extractUsage(ctx: AssertionContext): Record<string, unknown> | undefined {
  if (ctx.streamFrames !== undefined) {
    for (const f of ctx.streamFrames) {
      if (f.data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(f.data) as Record<string, unknown>;
        if (chunk.usage) return chunk.usage as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      try {
        if (f.event === "message_delta") {
          const data = JSON.parse(f.data) as { usage?: Record<string, unknown> };
          if (data.usage) return data.usage;
        }
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }
  const b = ctx.responseBody as Record<string, unknown> | undefined;
  return (b?.usage as Record<string, unknown> | undefined) ?? undefined;
}
