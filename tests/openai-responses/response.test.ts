/**
 * OpenAI Responses response conversion tests (responses.md §8/§9).
 *
 * Source protocol: openai-responses. Response parse (status/finishReason
 * decoupling, tool items, refusal, reasoning summary/text, usage split) and
 * render (status derivation, incomplete details, refusal structure, cache
 * usage composition, synthetic id policy).
 */
import { describe, expect, it } from "vitest";
import { getAdapter } from "../../src/codecs/registry.js";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CodecContext } from "../../src/codecs/protocol-adapter.js";
import { createSyntheticIdFactory } from "../../src/codecs/openai-responses/ids.js";

const responses = getAdapter("openai-responses");

function ctx(): CodecContext {
  return newCodecContext();
}

{
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
}

{
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
}
