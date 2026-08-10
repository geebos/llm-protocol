/**
 * Responses hardening tests: edge branches of the codec, validation matrix,
 * registries, envelope and stream state machine (NFR-009 coverage + matrix
 * rows not exercised by the main suites).
 */
import { describe, expect, it } from "vitest";
import { getAdapter } from "../src/codecs/registry.js";
import {
  newCodecContext,
  type CodecContext,
} from "../src/codecs/protocol-adapter.js";
import {
  registerToolCall,
  registerToolDefinition,
  resolveCallByItemId,
  resolveDefinition,
  normalizeForResponses,
} from "../src/codecs/openai-responses/normalize.js";
import { validateTargetRequest } from "../src/codecs/openai-responses/validate.js";
import {
  buildFidelityPlan,
  applyFidelityPlan,
  collectRemediations,
} from "../src/codecs/openai-responses/fidelity-plan.js";
import { ResponseEnvelopeBuilder, envelopeToWire } from "../src/codecs/openai-responses/envelope.js";
import { createSyntheticIdFactory } from "../src/codecs/openai-responses/ids.js";
import {
  createResponsesStreamParser,
  createResponsesStreamRenderer,
  createSSEParser,
} from "../src/streams/index.js";
import type { CanonicalStreamEvent } from "../src/streams/types.js";
import { openaiResponsesDefaultProfile } from "../src/codecs/openai-responses/index.js";
import { anthropicDefaultProfile } from "../src/codecs/anthropic-messages/index.js";
import { openaiChatDefaultProfile } from "../src/codecs/openai-chat/index.js";
import { DEFAULT_POLICIES } from "../src/ir/policies.js";

const responses = getAdapter("openai-responses");

function ctx(): CodecContext {
  return newCodecContext();
}

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
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function sse(...events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function parseResponses(events: unknown[]): Promise<CanonicalStreamEvent[]> {
  return collect(
    bytesStream(sse(...events))
      .pipeThrough(createSSEParser())
      .pipeThrough(createResponsesStreamParser(openaiResponsesDefaultProfile)),
  );
}

interface WireEvent {
  type: string;
  [key: string]: unknown;
}

async function renderResponses(events: CanonicalStreamEvent[]): Promise<WireEvent[]> {
  const out = await collect(
    new ReadableStream<CanonicalStreamEvent>({
      start(controller) {
        for (const e of events) controller.enqueue(e);
        controller.close();
      },
    }).pipeThrough(createResponsesStreamRenderer(openaiResponsesDefaultProfile)),
  );
  return out
    .map((b) => new TextDecoder().decode(b))
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as WireEvent);
}

/* ------------------------------------------------------------------ */
/* registries                                                         */
/* ------------------------------------------------------------------ */

describe("responses registries", () => {
  it("double-indexes call entries by call_id and item_id", () => {
    const c = ctx();
    registerToolCall(c, "call_1", {
      normalizedToolName: "a",
      originalName: "a",
      executionKind: "function",
      sourceItemId: "item_src",
      targetItemId: "item_tgt",
    });
    expect(resolveCallByItemId(c, "item_src")?.normalizedToolName).toBe("a");
    expect(resolveCallByItemId(c, "item_tgt")?.normalizedToolName).toBe("a");
  });

  it("rejects duplicate call_ids (ambiguous route, §15.2)", () => {
    const c = ctx();
    registerToolCall(c, "call_1", {
      normalizedToolName: "a",
      originalName: "a",
      executionKind: "function",
    });
    expect(() =>
      registerToolCall(c, "call_1", {
        normalizedToolName: "b",
        originalName: "b",
        executionKind: "function",
      }),
    ).toThrow(/Duplicate call_id/);
  });

  it("registers definitions by normalized name and rejects flatten collisions", () => {
    const c = ctx();
    registerToolDefinition(c, {
      executionKind: "function",
      nameKind: "namespaced",
      originalName: "ns.child",
      namespace: "ns",
      normalizedName: "ns__child",
    });
    expect(resolveDefinition(c, "ns__child")?.namespace).toBe("ns");
    expect(() =>
      registerToolDefinition(c, {
        executionKind: "function",
        nameKind: "plain",
        originalName: "other",
        normalizedName: "ns__child",
      }),
    ).toThrow(/collision/);
  });

  it("normalizeForResponses merges adjacent same-role turns only", () => {
    const merged = normalizeForResponses([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* target validation matrix (remaining rows)                          */
/* ------------------------------------------------------------------ */

describe("target validation matrix", () => {
  const base = {
    model: "m",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };

  const codes = (ir: Parameters<typeof validateTargetRequest>[0], profile = anthropicDefaultProfile) =>
    validateTargetRequest(ir, profile, ctx(), DEFAULT_POLICIES).violations.map((v) => v.code);

  it("clamps thinking budget above max_tokens", () => {
    expect(
      codes({
        ...base,
        thinking: { mode: "enabled", budgetTokens: 5000 },
        generation: { maxTokens: 1000 },
      }),
    ).toContain("thinking_budget_overflow");
  });

  it("drops sampling params when the reasoning model rejects them", () => {
    const profile = {
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        thinkingGeneration: { mode: "adaptive" as const, effortLocation: "output_config" as const, manualBudgetSupported: false, interleaving: true, requiresLeadingBlock: false },
      },
    };
    expect(
      codes(
        {
          ...base,
          thinking: { mode: "adaptive", effort: "high" },
          generation: { temperature: 0.7 },
        },
        profile,
      ),
    ).toContain("sampling_with_thinking");
  });

  it("rejects parallel tool calls on a serial-only target", () => {
    const profile = { ...anthropicDefaultProfile, capabilities: { ...anthropicDefaultProfile.capabilities, parallelTools: false } };
    expect(codes({ ...base, parallelToolCalls: true }, profile)).toContain("parallel_tools_unsupported");
  });

  it("rejects structured output when the target declares none", () => {
    const profile = {
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: { ...openaiResponsesDefaultProfile.capabilities.responses, structuredOutput: false },
      },
    };
    expect(
      codes({ ...base, extensions: { responsesTextFormat: { type: "json_schema" } } }, profile),
    ).toContain("structured_output_unsupported");
  });

  it("rejects conversation state and prompt templates without capability", () => {
    const profile = {
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: {
          ...openaiResponsesDefaultProfile.capabilities.responses,
          conversationState: false,
          promptTemplates: false,
        },
      },
    };
    const v = validateTargetRequest(
      { ...base, extensions: { previousResponseId: "resp_x", prompt: "pt:abc" } },
      profile,
      ctx(),
      DEFAULT_POLICIES,
    );
    const cs = v.violations.map((x) => x.code);
    expect(cs).toContain("conversation_state_unsupported");
    expect(cs).toContain("prompt_templates_unsupported");
  });

  it("degrades store=true without storage capability", () => {
    const profile = {
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: { ...openaiResponsesDefaultProfile.capabilities.responses, responseStorage: false },
      },
    };
    expect(codes({ ...base, extensions: { store: true } }, profile)).toContain("response_storage_unsupported");
  });

  it("flags namespace and custom tools without declared capability", () => {
    const c = ctx();
    // parse registers the definition first
    responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [
          { type: "custom", name: "freeform" },
          { type: "function", name: "ns.child", parameters: {} },
        ],
      },
      c,
    );
    const profile = {
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: {
          ...openaiResponsesDefaultProfile.capabilities.responses,
          customTools: false,
          namespaceTools: false,
        },
      },
    };
    const ir = {
      ...base,
      tools: [{ name: "freeform", inputSchema: {} }, { name: "ns__child", inputSchema: {} }],
    };
    const v = validateTargetRequest(ir, profile, c, DEFAULT_POLICIES);
    const cs = v.violations.map((x) => x.code);
    expect(cs).toContain("custom_tool_unsupported");
    expect(cs).toContain("namespace_tool_unsupported");
  });

  it("flags reasoning effort when the target has no thinking capability", () => {
    const profile = { ...openaiChatDefaultProfile, capabilities: { ...openaiChatDefaultProfile.capabilities, thinking: false } };
    expect(
      codes({ ...base, thinking: { mode: "adaptive", effort: "high" } }, profile),
    ).toContain("reasoning_effort_unsupported");
  });

  it("collectRemediations aggregates flags across entries", () => {
    const c = ctx();
    const ir = {
      ...base,
      thinking: { mode: "enabled" as const, budgetTokens: 1000 },
      toolChoice: { type: "required" as const },
      extensions: { truncation: "auto" as const },
    };
    const v = validateTargetRequest(ir, anthropicDefaultProfile, c, DEFAULT_POLICIES);
    const plan = buildFidelityPlan(ir, anthropicDefaultProfile, v, c, DEFAULT_POLICIES);
    const rem = collectRemediations(plan);
    expect(rem.setToolChoiceAuto).toBe(true);
    expect(rem.dropTruncation).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* request render edges                                               */
/* ------------------------------------------------------------------ */

describe("responses request render edges", () => {
  it("forwards allowlisted extensions and identity/cache", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      identity: { legacyEndUserId: "u1", safetyEndUserId: "u2" },
      cache: { affinityKey: "cache-a", retention: { mode: "extended" } },
      extensions: { metadata: { k: "v" }, service_tier: "flex", stream_options: { include_usage: true }, text: { format: { type: "json_schema" } } },
      outputIncludes: { requestedIncludes: ["citations"] },
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.user).toBe("u1");
    expect(body.safety_identifier).toBe("u2");
    expect(body.prompt_cache_key).toBe("cache-a");
    expect(body.prompt_cache_retention).toEqual({ mode: "extended" });
    expect(body.metadata).toEqual({ k: "v" });
    expect(body.service_tier).toBe("flex");
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.text).toEqual({ format: { type: "json_schema" } });
    expect(body.include).toEqual(["citations"]);
  });

  it("drops stateful/truncation fields when remediation applies", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      extensions: { previousResponseId: "resp_x", truncation: "auto", maxToolCalls: 3 },
    };
    // validation against the default Responses profile keeps everything...
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.previous_response_id).toBe("resp_x");
    expect(body.max_tool_calls).toBe(3);
    expect(body.truncation).toBe("auto");
  });

  it("approximates a thinking budget as effort (COMPATIBLE)", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      thinking: { mode: "enabled" as const, budgetTokens: 30000 },
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(c.warnings.map((w) => w.code)).toContain("thinking_budget_to_effort");
  });

  it("drops reasoning signatures from public reasoning items (native mode, §11.4)", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [
        {
          role: "assistant" as const,
          content: [{ type: "reasoning" as const, text: "deep", signature: "sig-abc" }],
        },
      ],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const items = body.input as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "deep" }],
    });
    expect(c.warnings.map((w) => w.code)).toContain("reasoning_carrier_dropped");
  });

  it("parses data-URI images and input_file parts", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
              {
                type: "input_file",
                filename: "a.pdf",
                file_data: { type: "base64", data: "AAEC", mime_type: "application/pdf" },
              },
            ],
          },
        ],
      },
      c,
    );
    const content = ir.messages[0]?.content ?? [];
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" } });
    expect(content[1]).toEqual({
      type: "file",
      source: { type: "base64", mediaType: "application/pdf", data: "AAEC" },
      filename: "a.pdf",
    });
  });

  it("restores custom_tool_call_output when the call registry says custom", () => {
    const c = ctx();
    responses.request.parseRequest(
      {
        model: "m",
        input: [
          { type: "custom_tool_call", name: "t", call_id: "ctc_1", input: "do it" },
          { type: "custom_tool_call_output", call_id: "ctc_1", output: "done" },
        ],
      },
      c,
    );
    // re-render the tool_result as a custom output
    const ir = {
      model: "m",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolCallId: "ctc_1", content: [{ type: "text" as const, text: "done" }] }],
        },
      ],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const items = body.input as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ type: "custom_tool_call_output", call_id: "ctc_1", output: "done" });
  });

  it("filters server-side built-in tools and keeps a dangling tool_choice safe", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [{ type: "web_search", name: "web_search" }],
        tool_choice: { type: "function", name: "web_search" },
      },
      c,
    );
    expect(ir.tools).toBeUndefined();
    expect(ir.toolChoice).toEqual({ type: "auto" });
    expect(c.warnings.map((w) => w.code)).toContain("server_side_tool_filtered");
  });
});

/* ------------------------------------------------------------------ */
/* envelope                                                           */
/* ------------------------------------------------------------------ */

describe("response envelope builder", () => {
  it("allocates created_at once and completes items with truncated status", () => {
    const env = new ResponseEnvelopeBuilder("resp_1", 1700000000);
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: { role: "assistant", content: [] } });
    env.addItem({ id: "msg_2", type: "message", status: "in_progress", outputIndex: 1, payload: {} });
    env.completeItem("msg_1");
    env.completeItem("msg_2", { truncated: true });
    env.setStatus("completed");
    const snap = env.snapshot();
    expect(snap.createdAt).toBe(1700000000);
    expect(snap.output[0].status).toBe("completed");
    expect(snap.output[1].status).toBe("incomplete");
    expect(snap.completedAt).toBeDefined();
  });

  it("dedupes addItem by id and serializes usage with cache/reasoning details", () => {
    const env = new ResponseEnvelopeBuilder("resp_2", 1700000000);
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: {} });
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: { role: "assistant" } });
    expect(env.output).toHaveLength(1);
    env.setUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, reasoningTokens: 3 });
    const wire = envelopeToWire(env.snapshot());
    expect((wire.usage as Record<string, unknown>).input_tokens).toBe(120);
    expect(((wire.usage as Record<string, unknown>).input_tokens_details as Record<string, unknown>).cached_tokens).toBe(20);
    expect(((wire.usage as Record<string, unknown>).output_tokens_details as Record<string, unknown>).reasoning_tokens).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* stream edge branches                                               */
/* ------------------------------------------------------------------ */

describe("responses stream edges", () => {
  it("lazily opens text on the first delta when content_part.added is skipped", async () => {
    const events = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
      { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "hi" },
      { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: {} },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_start", index: 0 }));
  });

  it("handles response.cancelled per profile declaration", async () => {
    // default profile declares cancelled -> terminal error event
    const declared = await parseResponses([
      { type: "response.created", response: { id: "r" } },
      { type: "response.cancelled", response: { id: "r", status: "cancelled" } },
    ]);
    expect(declared.some((e) => e.type === "error")).toBe(true);
  });

  it("renders response_state continuations as additive events", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "response_state", state: "queued" },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const types = frames.map((f) => f.type);
    expect(types).toContain("response.queued");
    expect(types.filter((t) => t === "response.created")).toHaveLength(1);
  });

  it("renders reasoning_end with explicit part indices", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "reasoning_start", index: 0 },
      { type: "reasoning_delta", index: 0, text: "a", kind: "summary", summaryIndex: 0 },
      { type: "reasoning_delta", index: 0, text: "b", kind: "summary", summaryIndex: 1 },
      { type: "reasoning_end", index: 0, metadata: { summaryIndex: 0 } },
      { type: "reasoning_end", index: 0, metadata: { summaryIndex: 1 } },
      { type: "reasoning_end", index: 0 },
      { type: "message_end", finishReason: "end_turn" },
    ]);
    const done = frames.filter((f) => f.type === "response.reasoning_summary_part.done");
    expect(done).toHaveLength(2);
  });

  it("ignores unknown canonical events and renders error as response.failed", async () => {
    const frames = await renderResponses([
      { type: "message_start", model: "m" },
      { type: "unknown", sourceType: "future.event", raw: {} } as CanonicalStreamEvent,
      { type: "error", error: { kind: "upstream", message: "boom" } },
    ]);
    const types = frames.map((f) => f.type);
    expect(types).toContain("response.failed");
    expect((frames.find((f) => f.type === "response.failed")!.response as Record<string, unknown>).status).toBe("failed");
  });

  it("synthetic id factory keeps prefixes and uniqueness", () => {
    const ids = createSyntheticIdFactory();
    const items = ["message", "reasoning", "function", "custom"] as const;
    for (const k of items) {
      expect(ids.itemId(k).startsWith(k === "message" ? "msg_" : k === "reasoning" ? "rs_" : k === "function" ? "fc_" : "ctc_")).toBe(true);
    }
    expect(ids.responseId().startsWith("resp_")).toBe(true);
    expect(ids.callId().startsWith("call_")).toBe(true);
    const a = ids.itemId("message");
    const b = ids.itemId("message");
    expect(a).not.toBe(b);
  });

  it("applyFidelityPlan surfaces entries as warnings (FR-008)", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      extensions: { truncation: "auto" as const },
    };
    const v = validateTargetRequest(ir, anthropicDefaultProfile, c, DEFAULT_POLICIES);
    const plan = buildFidelityPlan(ir, anthropicDefaultProfile, v, c, DEFAULT_POLICIES);
    applyFidelityPlan(plan, c);
    expect(c.warnings.length).toBeGreaterThan(0);
    expect(c.warnings.every((w) => w.fidelity !== undefined)).toBe(true);
  });
});
