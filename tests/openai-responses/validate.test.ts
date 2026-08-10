/**
 * Responses Target Validation + Fidelity Plan tests (responses.md §10).
 *
 * Cross-field constraints (thinking × tool_choice gated to Anthropic,
 * truncation, max_tool_calls, identity, empty tools × forced choice,
 * parallel/sampling/structured-output) and the Fidelity Plan layer
 * (blocking UNSUPPORTED decisions, outputIncludes merge, warning surfacing).
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
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";

const responses = getAdapter("openai-responses");

function ctx(): CodecContext {
  return newCodecContext();
}

{
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

  it("does NOT relax a forced tool_choice on a Responses target (review P1-7)", () => {
    // The Anthropic extended-thinking restriction is Anthropic-specific;
    // Responses reasoning + forced tool_choice are compatible and must not be
    // silently downgraded to auto.
    const c = ctx();
    const ir = {
      ...base,
      thinking: { mode: "adaptive" as const, effort: "high" as const },
      tools: [{ name: "get_weather", inputSchema: { type: "object" } }],
      toolChoice: { type: "required" as const },
    };
    const v = validateTargetRequest(ir, responses.profile, c, DEFAULT_POLICIES);
    expect(v.violations.map((x) => x.code)).not.toContain("thinking_tool_choice_limited");
    const body = responses.request.renderRequest(ir, false, c) as Record<string, unknown>;
    expect(body.tool_choice).toBe("required");
    expect(body.reasoning).toEqual({ effort: "high" });
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

  it("blocks a request whose Fidelity Plan is UNSUPPORTED, not just warns (review P0-2)", () => {
    // A Responses adapter whose profile does not declare conversation state
    // must REJECT previous_response_id instead of degrading silently.
    const adapter = createOpenAiResponsesAdapter({
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: {
          ...openaiResponsesDefaultProfile.capabilities.responses,
          conversationState: false,
        },
      },
    });
    const c = ctx();
    const ir = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      extensions: { previousResponseId: "resp_x" },
    };
    expect(() => adapter.request.renderRequest(ir, false, c)).toThrow(/conversation_state_unsupported/);
    // truncation=auto is UNSUPPORTED when the profile does not declare it.
    const adapter2 = createOpenAiResponsesAdapter({
      ...openaiResponsesDefaultProfile,
      capabilities: {
        ...openaiResponsesDefaultProfile.capabilities,
        responses: {
          ...openaiResponsesDefaultProfile.capabilities.responses,
          contextTruncation: { auto: false },
        },
      },
    });
    const ir2 = {
      model: "m",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      extensions: { truncation: "auto" },
    };
    expect(() => adapter2.request.renderRequest(ir2, false, c)).toThrow(/context_truncation_unsupported/);
  });
}
// placeholder

{
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
}
