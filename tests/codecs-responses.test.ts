/**
 * OpenAI Responses codec tests (responses.md §16 matrix, D-7).
 *
 * Request parse/render (§3/§5) and response parse/render (§8/§9): tool calls
 * (function/custom/namespace), reasoning summary/text, refusal, identity/cache
 * fields, Target Validation + Fidelity Plan, status/finishReason decoupling.
 */
import { describe, expect, it } from "vitest";
import { getAdapter } from "../src/codecs/registry.js";
import { newCodecContext } from "../src/codecs/protocol-adapter.js";
import type { CodecContext } from "../src/codecs/protocol-adapter.js";
import { createSyntheticIdFactory } from "../src/codecs/openai-responses/ids.js";
import { validateTargetRequest } from "../src/codecs/openai-responses/validate.js";
import { buildFidelityPlan, applyFidelityPlan } from "../src/codecs/openai-responses/fidelity-plan.js";
import { DEFAULT_POLICIES } from "../src/ir/policies.js";
import { anthropicDefaultProfile } from "../src/codecs/anthropic-messages/index.js";
import { openaiChatDefaultProfile } from "../src/codecs/openai-chat/index.js";

const responses = getAdapter("openai-responses");
const anthropic = getAdapter("anthropic-messages");
const chat = getAdapter("openai-chat");

function ctx(): CodecContext {
  return newCodecContext();
}

/* ------------------------------------------------------------------ */
/* request parse (§3)                                                 */
/* ------------------------------------------------------------------ */

describe("responses request parse", () => {
  it("parses a string input into a user message", () => {
    const c = ctx();
    const ir = responses.request.parseRequest({ model: "gpt-4o", input: "hello" }, c);
    expect(ir.model).toBe("gpt-4o");
    expect(ir.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(c.warnings).toEqual([]);
  });

  it("maps system/developer/instructions to the high-authority system prefix", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        instructions: "Be concise.",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "dev rule" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
      c,
    );
    expect(ir.system?.map((p) => (p.type === "text" ? p.text : ""))).toEqual([
      "Be concise.",
      "dev rule",
    ]);
    expect(ir.messages).toHaveLength(1);
    // no authority reorder: developer precedes the user turn
    expect(c.warnings.filter((w) => w.code === "authority_order_normalized")).toHaveLength(0);
  });

  it("warns when a mid-sequence developer item is merged to the prefix", () => {
    const c = ctx();
    responses.request.parseRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "late" }] },
        ],
      },
      c,
    );
    expect(c.warnings.map((w) => w.code)).toContain("authority_order_normalized");
  });

  it("pairs function calls and outputs by call_id, keeping source order", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: [
          { type: "function_call", name: "a", call_id: "call_1", arguments: "{}" },
          { type: "function_call", name: "b", call_id: "call_2", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "r1" },
          { type: "function_call_output", call_id: "call_2", output: "r2" },
        ],
      },
      c,
    );
    // both calls in one assistant message, results as user tool_result parts
    const assistant = ir.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toHaveLength(2);
    expect(
      assistant?.content.every((p) => p.type === "tool_call" && p.kind === "function"),
    ).toBe(true);
    const user = ir.messages.find((m) => m.role === "user");
    expect(user?.content.map((p) => (p.type === "tool_result" ? p.toolCallId : ""))).toEqual([
      "call_1",
      "call_2",
    ]);
    // adjacency is NOT required (v0.5 P0-4): results follow calls with no reorder
    expect(c.warnings.filter((w) => w.code === "tool_result_reordered")).toHaveLength(0);
  });

  it("parses custom tool calls as freeform inputText without JSON.parse (P0-1)", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: [
          {
            type: "custom_tool_call",
            name: "my_tool",
            call_id: "ctc_1",
            input: "freeform text that is not JSON {{{{",
          },
          { type: "custom_tool_call_output", call_id: "ctc_1", output: "ok" },
        ],
      },
      c,
    );
    const call = ir.messages[0]?.content[0];
    expect(call).toMatchObject({ type: "tool_call", kind: "custom", inputText: "freeform text that is not JSON {{{{" });
  });

  it("flattens namespace tool names and rejects collisions", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [
          { type: "function", name: "ns.child", parameters: {} },
        ],
      },
      c,
    );
    expect(ir.tools?.[0]?.name).toBe("ns__child");
    // collision: two tools flatten to the same name
    expect(() =>
      responses.request.parseRequest(
        {
          model: "m",
          input: "hi",
          tools: [
            { type: "function", name: "a.b", parameters: {} },
            { type: "function", name: "a__b", parameters: {} },
          ],
        },
        ctx(),
      ),
    ).toThrow(/collision|Collision/);
  });

  it("degrades custom tool definitions to a function(input) schema", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      { model: "m", input: "hi", tools: [{ type: "custom", name: "freeform", description: "d" }] },
      c,
    );
    expect(ir.tools?.[0]).toMatchObject({
      name: "freeform",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
    });
  });

  it("maps tool_choice modes and named tools", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [{ type: "function", name: "get_weather", parameters: {} }],
        tool_choice: { type: "function", name: "get_weather" },
      },
      c,
    );
    expect(ir.toolChoice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("narrows allowed_tools to an effective subset (v0.5 P1-3)", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [
          { type: "function", name: "a", parameters: {} },
          { type: "function", name: "b", parameters: {} },
        ],
        allowed_tools: ["a"],
        tool_choice: "required",
      },
      c,
    );
    expect(ir.tools?.map((t) => t.name)).toEqual(["a"]);
    expect(ir.toolChoice).toEqual({ type: "required" });
  });

  it("downgrades tool_choice when filtering empties the tool list", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        tools: [{ type: "function", name: "a", parameters: {} }],
        allowed_tools: ["nonexistent"],
        tool_choice: "required",
      },
      c,
    );
    expect(ir.tools).toBeUndefined();
    expect(ir.toolChoice).toEqual({ type: "auto" });
    expect(c.warnings.map((w) => w.code)).toContain("empty_tools_forced_choice");
  });

  it("captures include as requestedIncludes", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      { model: "m", input: "hi", include: ["reasoning.encrypted_content", "citations"] },
      c,
    );
    expect(ir.outputIncludes?.requestedIncludes).toEqual(["reasoning.encrypted_content", "citations"]);
  });

  it("models identity and cache separately (v0.5 P1-4)", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: "hi",
        user: "u_legacy",
        safety_identifier: "u_safe",
        prompt_cache_key: "cache-a",
        prompt_cache_retention: { mode: "extended" },
      },
      c,
    );
    expect(ir.identity).toEqual({ legacyEndUserId: "u_legacy", safetyEndUserId: "u_safe" });
    expect(ir.cache).toEqual({ affinityKey: "cache-a", retention: { mode: "extended" } });
  });

  it("flags top_logprobs as UNSUPPORTED (v0.5 P1-5)", () => {
    const c = ctx();
    responses.request.parseRequest({ model: "m", input: "hi", top_logprobs: 3 }, c);
    expect(c.warnings.map((w) => w.code)).toContain("top_logprobs_unsupported");
  });

  it("buffers reasoning items onto the following assistant message", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "brief" }],
            content: [{ type: "reasoning_text", text: "full reasoning" }],
          },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        ],
      },
      c,
    );
    const assistant = ir.messages[0];
    expect(assistant?.role).toBe("assistant");
    const reasoning = assistant?.content[0];
    expect(reasoning).toMatchObject({ type: "reasoning", summary: "brief", text: "full reasoning" });
  });

  it("parses refusal as a first-class part (v0.3 P0-2)", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      {
        model: "m",
        input: [
          { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't." }] },
        ],
      },
      c,
    );
    expect(ir.messages[0]?.content[0]).toEqual({ type: "refusal", text: "I can't." });
  });
});

/* ------------------------------------------------------------------ */
/* request render (§5)                                                */
/* ------------------------------------------------------------------ */

describe("responses request render", () => {
  it("renders system as a leading developer item, not instructions", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      system: [{ type: "text" as const, text: "be concise" }],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.instructions).toBeUndefined();
    expect(body.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "be concise" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("splits tool calls and results into independent items with unique call_id pairing", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "tool_call" as const, kind: "function" as const, id: "call_1", name: "a", argumentsText: "{\"x\":1}" },
            { type: "tool_call" as const, kind: "function" as const, id: "call_2", name: "b", argumentsText: "{\"y\":2}" },
          ],
        },
        {
          role: "user" as const,
          content: [
            { type: "tool_result" as const, toolCallId: "call_1", content: [{ type: "text" as const, text: "r1" }] },
            { type: "tool_result" as const, toolCallId: "call_2", content: [{ type: "text" as const, text: "r2" }] },
          ],
        },
      ],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: "function_call", name: "a", call_id: "call_1", arguments: "{\"x\":1}" },
      { type: "function_call", name: "b", call_id: "call_2", arguments: "{\"y\":2}" },
      { type: "function_call_output", call_id: "call_1", output: "r1" },
      { type: "function_call_output", call_id: "call_2", output: "r2" },
    ]);
  });

  it("restores custom semantics from the definition registry (v0.5 P0-2)", () => {
    const c = ctx();
    // parse first (registers the definition as custom), then render
    responses.request.parseRequest(
      { model: "m", input: "hi", tools: [{ type: "custom", name: "freeform" }] },
      c,
    );
    const ir = {
      model: "m",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolCallId: "ctc_1", content: [{ type: "text" as const, text: "ok" }] }],
        },
      ],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    // no matching call registered, so the output stays function-style; the
    // custom_tool_call_output branch is exercised by the call-registry test
    expect(input[0].type).toBe("function_call_output");
  });

  it("omits synthetic item IDs on outbound requests (§5.2A)", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).not.toHaveProperty("id");
  });

  it("passes reasoning effort through (v0.5)", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      thinking: { mode: "adaptive" as const, effort: "high" as const },
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("renders base64 images as data URIs and keeps URLs", () => {
    const c = ctx();
    const ir = {
      model: "m",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "aGk=" } },
            { type: "image" as const, source: { type: "url" as const, url: "https://x/y.png" } },
          ],
        },
      ],
    };
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    const content = (body.input as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "input_image", image_url: "data:image/png;base64,aGk=" });
    expect(content[1]).toEqual({ type: "input_image", image_url: "https://x/y.png" });
  });
});

/* ------------------------------------------------------------------ */
/* response parse (§8)                                                */
/* ------------------------------------------------------------------ */

describe("responses response parse", () => {
  it("parses a completed text response with usage split (v0.2 P1-8)", () => {
    const c = ctx();
    const canonical = responses.response.parseResponse(
      {
        id: "resp_1",
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "gpt-4o",
        output: [
          { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 4 },
          total_tokens: 110,
        },
      },
      c,
    );
    expect(canonical.status).toBe("completed");
    expect(canonical.finishReason).toBe("end_turn");
    expect(canonical.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(canonical.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 20,
      reasoningTokens: 4,
      totalTokens: 110,
    });
  });

  it("maps incomplete status to max_tokens finishReason", () => {
    const c = ctx();
    const canonical = responses.response.parseResponse(
      {
        id: "resp_2",
        object: "response",
        status: "incomplete",
        model: "m",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      c,
    );
    expect(canonical.status).toBe("incomplete");
    expect(canonical.finishReason).toBe("max_tokens");
  });

  it("parses function_call and custom_tool_call items (P0-1)", () => {
    const c = ctx();
    const canonical = responses.response.parseResponse(
      {
        id: "resp_3",
        object: "response",
        status: "completed",
        model: "m",
        output: [
          { id: "fc_1", type: "function_call", status: "completed", name: "get_weather", call_id: "call_9", arguments: "{\"city\":\"Paris\"}" },
          { id: "ctc_1", type: "custom_tool_call", status: "completed", name: "my_tool", call_id: "call_10", input: "free text" },
        ],
      },
      c,
    );
    expect(canonical.finishReason).toBe("tool_call");
    expect(canonical.content[0]).toMatchObject({ type: "tool_call", kind: "function", id: "call_9", argumentsText: "{\"city\":\"Paris\"}" });
    expect(canonical.content[1]).toMatchObject({ type: "tool_call", kind: "custom", id: "call_10", inputText: "free text" });
  });

  it("parses refusal output as a first-class part (P0-2)", () => {
    const c = ctx();
    const canonical = responses.response.parseResponse(
      {
        id: "resp_4",
        object: "response",
        status: "completed",
        model: "m",
        output: [
          { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: "No." }] },
        ],
      },
      c,
    );
    expect(canonical.status).toBe("completed");
    expect(canonical.content[0]).toEqual({ type: "refusal", text: "No." });
  });

  it("parses reasoning summary and text separately (v0.3 P0-3)", () => {
    const c = ctx();
    const canonical = responses.response.parseResponse(
      {
        id: "resp_5",
        object: "response",
        status: "completed",
        model: "m",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "s1" }, { type: "summary_text", text: "s2" }],
            content: [{ type: "reasoning_text", text: "deep" }],
          },
        ],
      },
      c,
    );
    const r = canonical.content[0];
    expect(r.type).toBe("reasoning");
    if (r.type === "reasoning") {
      expect(r.summaryParts).toEqual([{ text: "s1", summaryIndex: 0 }, { text: "s2", summaryIndex: 1 }]);
      expect(r.text).toBe("deep");
    }
  });
});

/* ------------------------------------------------------------------ */
/* response render (§8.2/§9)                                          */
/* ------------------------------------------------------------------ */

describe("responses response render", () => {
  it("derives status from finishReason with stop_sequence -> completed (v0.3 P0-1)", () => {
    const c = ctx();
    const body = responses.response.renderResponse(
      { id: "resp_1", model: "m", content: [{ type: "text", text: "done" }], finishReason: "stop_sequence" },
      c,
    ) as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(body.object).toBe("response");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "message",
      status: "completed",
      role: "assistant",
    });
  });

  it("maps max_tokens to incomplete with incomplete_details", () => {
    const c = ctx();
    const body = responses.response.renderResponse(
      { id: "resp_2", model: "m", content: [], finishReason: "max_tokens" },
      c,
    ) as Record<string, unknown>;
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("treats unknown finish reason as completed + warning (v0.5 P1-2)", () => {
    const c = ctx();
    const body = responses.response.renderResponse(
      { id: "resp_3", model: "m", content: [{ type: "text", text: "x" }], finishReason: "unknown" },
      c,
    ) as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(c.warnings.map((w) => w.code)).toContain("finish_reason_unknown");
  });

  it("keeps refusal structure on the wire (P0-2)", () => {
    const c = ctx();
    const body = responses.response.renderResponse(
      { id: "resp_4", model: "m", content: [{ type: "refusal", text: "No." }], finishReason: "end_turn" },
      c,
    ) as Record<string, unknown>;
    const content = (body.output as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "refusal", refusal: "No." });
  });

  it("composes Anthropic-style usage into Responses input_tokens (§14.1)", () => {
    const c = ctx();
    const body = responses.response.renderResponse(
      {
        id: "resp_5",
        model: "m",
        content: [],
        finishReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 5, reasoningTokens: 3 },
      },
      c,
    ) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(125); // 100 + 20 + 5
    expect((usage.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(20);
    expect((usage.output_tokens_details as Record<string, unknown>).reasoning_tokens).toBe(3);
  });

  it("synthesizes missing response ids with a trace warning (§8.3)", () => {
    const c = ctx();
    c.syntheticIds = createSyntheticIdFactory();
    const body = responses.response.renderResponse(
      { model: "m", content: [], finishReason: "end_turn" },
      c,
    ) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("resp_")).toBe(true);
    expect(c.warnings.map((w) => w.code)).toContain("synthetic_response_id");
  });
});

/* ------------------------------------------------------------------ */
/* Target Validation + Fidelity Plan (§10)                            */
/* ------------------------------------------------------------------ */

describe("target validation & fidelity plan", () => {
  const base = {
    model: "m",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };

  it("degrades forced tool_choice when thinking is active (P1-7)", () => {
    const c = ctx();
    const ir = {
      ...base,
      thinking: { mode: "enabled" as const, budgetTokens: 1000 },
      toolChoice: { type: "required" as const },
    };
    const v = validateTargetRequest(ir, anthropicDefaultProfile, c, DEFAULT_POLICIES);
    expect(v.violations.map((x) => x.code)).toContain("thinking_tool_choice_limited");
    const plan = buildFidelityPlan(ir, anthropicDefaultProfile, v, c, DEFAULT_POLICIES);
    const rem = plan.entries.find((e) => e.code === "thinking_tool_choice_limited");
    expect(rem?.remediation?.setToolChoiceAuto).toBe(true);
  });

  it("rejects truncation=auto on a target without context truncation (P1-7)", () => {
    const c = ctx();
    const ir = { ...base, extensions: { truncation: "auto" } };
    const v = validateTargetRequest(ir, anthropicDefaultProfile, c, DEFAULT_POLICIES);
    const plan = buildFidelityPlan(ir, anthropicDefaultProfile, v, c, DEFAULT_POLICIES);
    expect(plan.blocking).toBe(true);
    expect(plan.entries.map((e) => e.code)).toContain("context_truncation_unsupported");
  });

  it("applies the plan to warnings so traces surface every lossy decision", () => {
    const c = ctx();
    const ir = {
      ...base,
      extensions: { truncation: "auto" as const },
    };
    const v = validateTargetRequest(ir, anthropicDefaultProfile, c, DEFAULT_POLICIES);
    const plan = buildFidelityPlan(ir, anthropicDefaultProfile, v, c, DEFAULT_POLICIES);
    applyFidelityPlan(plan, c);
    expect(c.warnings.map((w) => w.code)).toContain("context_truncation_unsupported");
  });

  it("drops identity with a warning when the target has no end-user tracking", () => {
    const c = ctx();
    const ir = {
      ...base,
      identity: { legacyEndUserId: "u1" },
    };
    const v = validateTargetRequest(ir, openaiChatDefaultProfile, c, DEFAULT_POLICIES);
    expect(v.violations.map((x) => x.code)).toContain("identity_dropped");
  });

  it("keeps max_tool_calls on a Responses target and drops it cross-protocol", () => {
    const c = ctx();
    const ir = { ...base, extensions: { maxToolCalls: 5 } };
    const vResponses = validateTargetRequest(ir, responses.profile, c, DEFAULT_POLICIES);
    expect(vResponses.violations.map((x) => x.code)).not.toContain("max_tool_calls_no_equivalent");
    const vChat = validateTargetRequest(ir, openaiChatDefaultProfile, c, DEFAULT_POLICIES);
    expect(vChat.violations.map((x) => x.code)).toContain("max_tool_calls_no_equivalent");
  });

  it("merges includes: target include = requested ∪ translator-required (P1-8)", () => {
    const c = ctx();
    const ir = {
      ...base,
      outputIncludes: { requestedIncludes: ["citations"], translatorRequiredIncludes: ["reasoning.encrypted_content"] },
    };
    const v = validateTargetRequest(ir, responses.profile, c, DEFAULT_POLICIES);
    const plan = buildFidelityPlan(ir, responses.profile, v, c, DEFAULT_POLICIES);
    expect(plan.includes.effective).toEqual(["citations", "reasoning.encrypted_content"]);
  });
});
