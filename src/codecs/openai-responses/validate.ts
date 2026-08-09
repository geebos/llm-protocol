/**
 * Target Validation Matrix (responses.md §10.1, D-10).
 *
 * Cross-field combination constraints live here, not scattered across
 * renderers. Every check has a fixed default behavior (reject / degrade +
 * LOSSY warning / drop + warning). This module only *validates*: it never
 * mutates the canonical request; the Fidelity Plan consumes violations and the
 * renderers execute the remediation.
 */
import type { CanonicalRequest } from "../../ir/types.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import type { CodecContext } from "../protocol-adapter.js";
import { resolveDefinition } from "./normalize.js";

export type ViolationKind = "reject" | "degrade";

export interface ValidationViolation {
  code: string;
  message: string;
  kind: ViolationKind;
  field?: string;
  /** Machine-readable remediation consumed by renderers. */
  remediation?: {
    setToolChoiceAuto?: boolean;
    dropSampling?: boolean;
    dropStateful?: boolean;
    dropMaxToolCalls?: boolean;
    dropTruncation?: boolean;
    dropIdentity?: boolean;
    dropEffort?: boolean;
  };
}

export interface ValidationResult {
  violations: ValidationViolation[];
}

export function validateTargetRequest(
  canonical: CanonicalRequest,
  target: ProviderProfile,
  ctx: CodecContext,
  policies: TranslationPolicies,
): ValidationResult {
  const violations: ValidationViolation[] = [];
  const caps = target.capabilities;
  const res = caps.responses;
  const toolChoice = canonical.toolChoice;
  const tools = canonical.tools;
  const gen = canonical.generation;
  const thinking = canonical.thinking;

  // 1. thinking × toolChoice: extended thinking only tolerates auto/none.
  const thinkingActive =
    thinking !== undefined &&
    (thinking.mode === "enabled" || thinking.mode === "adaptive");
  if (
    thinkingActive &&
    (toolChoice?.type === "required" || toolChoice?.type === "tool")
  ) {
    violations.push({
      code: "thinking_tool_choice_limited",
      message:
        "Thinking with a forced tool_choice (required/named) is unsupported; defaulting tool_choice to auto",
      kind: "degrade",
      field: "toolChoice",
      remediation: { setToolChoiceAuto: true },
    });
  }

  // 2. thinking × maxTokens: budget must stay below max_tokens.
  if (
    thinkingActive &&
    thinking.mode === "enabled" &&
    thinking.budgetTokens !== undefined &&
    gen?.maxTokens !== undefined &&
    thinking.budgetTokens >= gen.maxTokens
  ) {
    violations.push({
      code: "thinking_budget_overflow",
      message: `Thinking budget ${thinking.budgetTokens} must be < max_tokens ${gen.maxTokens}; clamped`,
      kind: "degrade",
      field: "thinking.budgetTokens",
    });
  }

  // 3. thinking × temperature/top_p: reasoning models often forbid sampling.
  if (
    thinkingActive &&
    (gen?.temperature !== undefined || gen?.topP !== undefined) &&
    thinkingGenerationRejectsSampling(caps)
  ) {
    violations.push({
      code: "sampling_with_thinking",
      message:
        "Sampling parameters (temperature/top_p) dropped for a reasoning-model target that rejects them",
      kind: "degrade",
      field: "generation",
      remediation: { dropSampling: true },
    });
  }

  // 4. truncation=auto × capability.
  const truncation = (canonical.extensions as Record<string, unknown> | undefined)
    ?.truncation;
  if (truncation === "auto" && !res?.contextTruncation?.auto) {
    violations.push({
      code: "context_truncation_unsupported",
      message:
        "truncation=auto is UNSUPPORTED: the target does not declare item-aware context truncation",
      kind: "reject",
      field: "extensions.truncation",
      remediation: { dropTruncation: true },
    });
  }

  // 5. max_tool_calls: built-in/server-side tools only; no equivalent target
  //    limit must never map to function/parallel/round limits.
  const maxToolCalls = (canonical.extensions as Record<string, unknown> | undefined)
    ?.maxToolCalls;
  if (maxToolCalls !== undefined && target.protocol !== "openai-responses") {
    violations.push({
      code: "max_tool_calls_no_equivalent",
      message:
        "max_tool_calls (built-in tools global limit) has no equivalent on this target; dropped",
      kind: "degrade",
      field: "extensions.maxToolCalls",
      remediation: { dropMaxToolCalls: true },
    });
  }

  // 6. identity × target: no end-user tracking field -> drop + warning.
  const identity = canonical.identity;
  if (identity !== undefined) {
    const tracked =
      identity.legacyEndUserId !== undefined && res?.identity?.endUserTracking?.legacy;
    const safe =
      identity.safetyEndUserId !== undefined && res?.identity?.endUserTracking?.safety;
    if (
      (identity.legacyEndUserId !== undefined && !tracked) ||
      (identity.safetyEndUserId !== undefined && !safe)
    ) {
      violations.push({
        code: "identity_dropped",
        message:
          "End-user identity dropped because the target does not declare end-user tracking",
        kind: "degrade",
        field: "identity",
        remediation: { dropIdentity: true },
      });
    }
  }

  // 7. empty tools × forced toolChoice -> upstream 400.
  if (
    (tools === undefined || tools.length === 0) &&
    (toolChoice?.type === "required" || toolChoice?.type === "tool")
  ) {
    violations.push({
      code: "empty_tools_forced_choice",
      message:
        "Empty tool list with a forced tool_choice would 400 upstream; defaulting to auto",
      kind: "degrade",
      field: "toolChoice",
      remediation: { setToolChoiceAuto: true },
    });
  }

  // 8. parallel tools requested but target does not support them.
  if (
    canonical.parallelToolCalls === true &&
    caps.parallelTools === false
  ) {
    violations.push({
      code: "parallel_tools_unsupported",
      message:
        "parallel_tool_calls requested but the target does not support parallel tools; degraded to serial",
      kind: "degrade",
      field: "parallelToolCalls",
    });
  }

  // 9. structured output × capability.
  const textFormat = (canonical.extensions as Record<string, unknown> | undefined)
    ?.responsesTextFormat;
  if (textFormat !== undefined && res?.structuredOutput === false) {
    violations.push({
      code: "structured_output_unsupported",
      message:
        "text.format structured output is not supported by the target; dropped",
      kind: "degrade",
      field: "extensions.responsesTextFormat",
    });
  }

  // 10. stateful fields × capability bits.
  const ext = canonical.extensions as Record<string, unknown> | undefined;
  const previousResponseId = ext?.previousResponseId;
  const conversation = ext?.conversation;
  const store = ext?.store;
  const prompt = ext?.prompt;
  if (previousResponseId !== undefined || conversation !== undefined) {
    if (res?.conversationState !== true) {
      violations.push({
        code: "conversation_state_unsupported",
        message:
          "previous_response_id/conversation require server-side conversation state the target does not declare",
        kind: "reject",
        field: "extensions",
        remediation: { dropStateful: true },
      });
    }
  }
  if (store === true && res?.responseStorage !== true) {
    violations.push({
      code: "response_storage_unsupported",
      message: "store=true requires response storage the target does not declare",
      kind: "degrade",
      field: "extensions.store",
    });
  }
  if (prompt !== undefined && res?.promptTemplates !== true) {
    violations.push({
      code: "prompt_templates_unsupported",
      message:
        "prompt template references require promptTemplates capability the target does not declare",
      kind: "reject",
      field: "extensions.prompt",
      remediation: { dropStateful: true },
    });
  }

  // 11. custom/namespace tools × target capability (via Definition Registry).
  const customToolNames = new Set<string>();
  for (const tool of tools ?? []) {
    const def = resolveDefinition(ctx, tool.name);
    if (def?.executionKind === "custom") customToolNames.add(tool.name);
    if (def?.nameKind === "namespaced" && res?.namespaceTools !== true) {
      violations.push({
        code: "namespace_tool_unsupported",
        message: `Namespaced tool "${tool.name}" cannot be represented on this target; flattened name used`,
        kind: "degrade",
        field: `tools.${tool.name}`,
      });
    }
  }
  if (customToolNames.size > 0 && res?.customTools === false) {
    violations.push({
      code: "custom_tool_unsupported",
      message:
        "Custom/freeform tools are not supported by the target; degraded to function(input)",
      kind: "degrade",
      field: `tools.${[...customToolNames][0]}`,
    });
  }

  // 12. reasoning effort × target thinking capability.
  if (
    thinking?.effort !== undefined &&
    !target.capabilities.thinking &&
    caps.thinkingGeneration?.mode !== "adaptive"
  ) {
    violations.push({
      code: "reasoning_effort_unsupported",
      message:
        "Reasoning effort requested but the target has no thinking capability",
      kind: policies.reasoning === "reject" ? "reject" : "degrade",
      field: "thinking",
      remediation: { dropEffort: true },
    });
  }

  return { violations };
}

function thinkingGenerationRejectsSampling(
  caps: ProviderProfile["capabilities"],
): boolean {
  // Adaptive/manual thinking with a declared generation dialect may forbid
  // sampling; unknown dialect defaults to allowing (no violation).
  return (
    caps.thinkingGeneration?.mode === "adaptive" &&
    caps.thinkingGeneration.effortLocation === "output_config"
  );
}
