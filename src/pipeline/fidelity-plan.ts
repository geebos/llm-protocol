/**
 * Fidelity Plan (responses.md §10.0, D-11).
 *
 * A translation generates a target-side fidelity plan *before* mutating the IR:
 * every LOSSY/UNSUPPORTED decision is a plan entry (code + fidelity + field +
 * remediation) that can be unit-tested and traced. Renderers execute the
 * remediations and surface entries as TranslationWarnings, so the renderer
 * never warns while it degrades ad hoc.
 *
 * Shared across ALL targets (review round 2): the pipeline builds the plan
 * once per translation and hands the aggregated remediations to the target
 * renderer, so a degrade is always executable — never a bare warning.
 *
 * outputIncludes merge (v0.4 P1-8): target include = requested ∪
 * translator-required. The translator never overrides client includes.
 */
import type { CanonicalRequest } from "../ir/types.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";
import type { Fidelity } from "../ir/fidelity.js";
import type { CodecContext } from "../codecs/protocol-adapter.js";
import type { ValidationResult, ValidationViolation } from "./target-validation.js";

/** Aggregated remediation flags a renderer can branch on. */
export interface Remediations {
  setToolChoiceAuto: boolean;
  dropSampling: boolean;
  dropStateful: boolean;
  dropMaxToolCalls: boolean;
  dropTruncation: boolean;
  dropIdentity: boolean;
  dropEffort: boolean;
  /** parallel_tool_calls=true on a serial-only target -> force serial. */
  forceSerialToolCalls: boolean;
  /** structured output (`text.format`) unsupported -> drop it. */
  dropTextFormat: boolean;
}

/** No-op remediations for direct codec use without a pipeline plan. */
export const NO_REMEDIATIONS: Remediations = {
  setToolChoiceAuto: false,
  dropSampling: false,
  dropStateful: false,
  dropMaxToolCalls: false,
  dropTruncation: false,
  dropIdentity: false,
  dropEffort: false,
  forceSerialToolCalls: false,
  dropTextFormat: false,
};

export function collectRemediations(plan: FidelityPlan): Remediations {
  const out: Remediations = {
    setToolChoiceAuto: false,
    dropSampling: false,
    dropStateful: false,
    dropMaxToolCalls: false,
    dropTruncation: false,
    dropIdentity: false,
    dropEffort: false,
    forceSerialToolCalls: false,
    dropTextFormat: false,
  };
  for (const entry of plan.entries) {
    for (const [key, value] of Object.entries(entry.remediation ?? {})) {
      if (value === true && key in out) {
        (out as unknown as Record<string, boolean>)[key] = true;
      }
    }
  }
  return out;
}

export interface FidelityPlanEntry {
  code: string;
  message: string;
  fidelity: Fidelity;
  field?: string;
  /** Human-readable remediation summary (also machine-readable in `remediation`). */
  action?: string;
  /** Machine-readable remediation consumed by renderers. */
  remediation?: ValidationViolation["remediation"];
}

export interface IncludeMerge {
  requested: string[];
  required: string[];
  effective: string[];
}

export interface FidelityPlan {
  entries: FidelityPlanEntry[];
  includes: IncludeMerge;
  /** Violations that require rejecting the request outright. */
  blocking: boolean;
}

const VIOLATION_FIDELITY: Record<ValidationViolation["kind"], Fidelity> = {
  reject: "UNSUPPORTED",
  degrade: "LOSSY",
};

/** Render a ValidationViolation into a plan entry (code/action kept stable). */
function violationToEntry(v: ValidationViolation): FidelityPlanEntry {
  return {
    code: v.code,
    message: v.message,
    fidelity: VIOLATION_FIDELITY[v.kind],
    field: v.field,
    action: v.kind === "reject" ? "reject_request" : "degrade",
    remediation: v.remediation,
  };
}

export function buildFidelityPlan(
  canonical: CanonicalRequest,
  _target: ProviderProfile,
  validation: ValidationResult,
  _ctx: CodecContext,
  _policies: TranslationPolicies,
): FidelityPlan {
  const entries: FidelityPlanEntry[] = validation.violations.map(violationToEntry);

  // outputIncludes: requested (client preference) ∪ required (translator
  // necessity). Translator-required includes are decided by the adapter; v1
  // uses none by default, keeping the client's include untouched.
  const requested = canonical.outputIncludes?.requestedIncludes ?? [];
  const required = canonical.outputIncludes?.translatorRequiredIncludes ?? [];
  const effective = [...new Set([...requested, ...required])];

  const blocking = validation.violations.some((v) => v.kind === "reject");

  return { entries, includes: { requested, required, effective }, blocking };
}

/** Apply a plan to the shared context: every entry becomes a warning (FR-008). */
export function applyFidelityPlan(
  plan: FidelityPlan,
  ctx: CodecContext,
): void {
  for (const entry of plan.entries) {
    ctx.warnings.push({
      code: entry.code,
      message: entry.message,
      fidelity: entry.fidelity,
      ...(entry.field !== undefined ? { field: entry.field } : {}),
    });
  }
}
