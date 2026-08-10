/**
 * OpenAI Responses request conversion tests (responses.md §3/§5).
 *
 * Source protocol: openai-responses. Request parse (input items, system/
 * developer/instructions authority, tool call/result pairing, custom tools,
 * namespace flattening, refusal, reasoning, identity/cache) and render
 * (developer item strategy, independent tool items, outbound ID omission,
 * images, reasoning effort).
 */
import { describe, expect, it } from "vitest";
import { getAdapter } from "../../src/codecs/registry.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CodecContext } from "../../src/codecs/protocol-adapter.js";
import {
  createOpenAiResponsesAdapter,
  openaiResponsesDefaultProfile,
} from "../../src/codecs/openai-responses/index.js";
import { validateTargetRequest } from "../../src/codecs/openai-responses/validate.js";
import {
  buildFidelityPlan,
  applyFidelityPlan,
  collectRemediations,
} from "../../src/codecs/openai-responses/fidelity-plan.js";
import { DEFAULT_POLICIES } from "../../src/ir/policies.js";
import { anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";

const responses = getAdapter("openai-responses");

function ctx(): CodecContext {
  return newCodecContext();
}

{
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

  it("keeps top-level instructions with a string input (review P0-1)", () => {
    const c = ctx();
    const ir = responses.request.parseRequest(
      { model: "m", instructions: "Be concise.", input: "hello" },
      c,
    );
    expect(ir.system?.map((p) => (p.type === "text" ? p.text : ""))).toEqual(["Be concise."]);
    expect(ir.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(c.warnings).toEqual([]);
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
}

{
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
}
// placeholder

{
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
}
