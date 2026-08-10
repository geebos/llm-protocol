/**
 * Target-side validation layer (responses.md §10.0/§10.1, D-10).
 *
 * Shared across ALL targets — the frozen seven-stage pipeline is
 *   Source Parse -> Canonical Validate -> Capability Resolve ->
 *   Target Validate -> Fidelity Plan -> Target Normalize -> Render.
 *
 * This module owns two stages:
 * - `validateCanonicalRequest`: IR-internal invariants (Canonical Validate),
 *   independent of the target protocol;
 * - `validateTargetRequest`: cross-field combination constraints (Target
 *   Validate), driven by the target ProviderProfile. It only *validates*: it
 *   never mutates the canonical request; the Fidelity Plan consumes the
 *   violations and the renderers execute the remediation (review round 2).
 */
import type { CanonicalRequest } from "../ir/types.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";
import { validationError } from "../errors.js";
import type { CodecContext } from "../codecs/protocol-adapter.js";
import { resolveDefinition } from "../codecs/openai-responses/normalize.js";

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
    /** parallel_tool_calls=true on a serial-only target -> force serial. */
    forceSerialToolCalls?: boolean;
    /** structured output (`text.format`) unsupported -> drop it. */
    dropTextFormat?: boolean;
  };
}

export interface ValidationResult {
  violations: ValidationViolation[];
}

/**
 * Canonical Validate (responses.md §10.0): IR-internal invariants, checked
 * before any target-specific logic. A function tool call's `argumentsText`
 * must parse to a JSON object — otherwise the Anthropic renderer would
 * silently turn broken arguments into `{}` (review round 2, Canonical
 * Validate gap). Custom (`inputText`) payloads are freeform and never parsed.
 */
export function validateCanonicalRequest(
  canonical: CanonicalRequest,
): void {
  for (const message of canonical.messages) {
    for (const part of message.content) {
      if (part.type !== "tool_call" || part.kind !== "function") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(part.argumentsText);
      } catch {
        throw validationError(
          `Function tool call "${part.name}" has arguments that are not valid JSON: cannot be parsed`,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw validationError(
          `Function tool call "${part.name}" arguments must parse to a JSON object`,
        );
      }
    }
  }
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

  // 1. thinking × toolChoice: Anthropic extended thinking only tolerates
  //    auto/none. This is an Anthropic-specific constraint (review P1-7):
  //    Responses reasoning + tool_choice are compatible, so the rule must not
  //    silently relax a forced tool_choice on a Responses target.
  const thinkingActive =
    thinking !== undefined &&
    (thinking.mode === "enabled" || thinking.mode === "adaptive");
  if (
    target.protocol === "anthropic-messages" &&
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

  // 2. thinking × maxTokens: Anthropic budget must stay below max_tokens.
  //    Anthropic-specific (Responses has no budget concept).
  if (
    target.protocol === "anthropic-messages" &&
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

  // 8. parallel tools requested but target does not support them: degrade to
  //    serial, and the renderer must actually flip parallel_tool_calls to
  //    false (review round 2: every degrade needs an executable remediation).
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
      remediation: { forceSerialToolCalls: true },
    });
  }

  // 9. structured output × capability: drop text.format on the wire.
  const textFormat = (canonical.extensions as Record<string, unknown> | undefined)
    ?.responsesTextFormat;
  if (textFormat !== undefined && res?.structuredOutput === false) {
    violations.push({
      code: "structured_output_unsupported",
      message:
        "text.format structured output is not supported by the target; dropped",
      kind: "degrade",
      field: "extensions.responsesTextFormat",
      remediation: { dropTextFormat: true },
    });
  }

  // 10. stateful fields × capability bits. previous_response_id / conversation
  //     are REAL server-side state dependencies: the target must declare
  //     conversationState or the request is rejected — never silently turned
  //     into a stateless request (review round 2, P0).
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
      remediation: { dropStateful: true },
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

  // 12. reasoning effort × target thinking capability. OpenAI Chat renders
  //     reasoning_effort natively (regardless of its declared thinking bit),
  //     so it must not be flagged for a Chat target (review round 2: the
  //     shared pipeline must not regress Responses -> Chat reasoning effort).
  if (
    thinking?.effort !== undefined &&
    target.protocol !== "openai-chat" &&
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
