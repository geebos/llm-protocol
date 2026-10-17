/**
 * Projection Planner (docs/07.ir-native-codec.md §6).
 *
 * Centralizes the field-faithfulness decision so codecs never inline
 * drop/throw logic:
 *
 * - four-state adjudication (§6.2): rendered / transformed / adapted / unsupported;
 * - field policy + overrides (§5.9);
 * - Plan / Execute separation with a stability check (§6.5, E-9);
 * - drop / adaptation audit records that survive a mid-walk throw (§6.5 settlement).
 *
 * The Planner decides *whether* a field may be dropped; it never decides whether
 * the target can express it (that is the codec's `ProjectionOutcome`).
 */
import { TranslationError, validationError } from "../../errors.js";
import type { DropPolicy, FieldPolicy, FieldPolicyContext } from "../policy/policy.js";
import type { ProjectionContext } from "./context.js";
import type { DropRecord, FeatureAdaptationRecord } from "./drop-record.js";
import type { ProjectionOutcome } from "./outcome.js";
import { findOverride, validateOverride, type PolicyOverride } from "./override.js";

/** Fail-closed error for a `required` field the target cannot express (§6.4). */
export function nonDroppableFieldError(
  context: ProjectionContext,
  path: string,
): TranslationError {
  return new TranslationError({
    kind: "unsupported",
    code: "non_droppable_field",
    message: `field ${path} is not representable in ${context.outputFormat} and cannot be dropped`,
  });
}

function resolvePolicy(
  policy: FieldPolicy | undefined,
  context: FieldPolicyContext,
): DropPolicy | undefined {
  if (policy === undefined) return undefined;
  return typeof policy === "function" ? policy(context) : policy;
}

/** Explicit feature-adaptation authorization (§6.2.1). */
export interface FieldAdaptationAuthorization {
  feature: string;
  authorized: boolean;
  lossy: boolean;
}

export interface DecideFieldInput {
  context: ProjectionContext;
  path: string;
  value: unknown;
  /** Field policy from the protocol policy table. */
  policy: FieldPolicy | undefined;
  /** What the codec determined about target expressibility. */
  outcome: ProjectionOutcome;
  adaptation?: FieldAdaptationAuthorization;
  overrides?: readonly PolicyOverride[];
  /** Policy used when the table declares none; fail-closed to `required` (§5.7). */
  fallback?: DropPolicy;
}

export type FieldDecision =
  | {
      readonly action: "keep";
      readonly path: string;
      readonly state: "rendered" | "transformed";
    }
  | { readonly action: "adapt"; readonly path: string; readonly record: FeatureAdaptationRecord }
  | { readonly action: "drop"; readonly path: string; readonly record: DropRecord };

export function decideField(input: DecideFieldInput): FieldDecision {
  const { context, path } = input;
  switch (input.outcome.kind) {
    case "rendered":
      return { action: "keep", path, state: "rendered" };
    case "transformed":
      return { action: "keep", path, state: "transformed" };
    case "adapted":
      if (input.adaptation?.authorized) {
        return {
          action: "adapt",
          path,
          record: {
            phase: context.phase,
            path,
            feature: input.adaptation.feature,
            lossy: input.adaptation.lossy,
            sourceFormat: context.inputFormat,
            targetFormat: context.outputFormat,
          },
        };
      }
      // An unauthorized approximation is just an unsupported field.
      return applyPolicy(input, "unrepresentable");
    case "unsupported":
      return applyPolicy(input, input.outcome.cause);
  }
}

function applyPolicy(
  input: DecideFieldInput,
  cause: DropRecord["cause"],
): FieldDecision {
  const { context, path } = input;
  const override = findOverride(input.overrides, context, path);
  if (override) validateOverride(override);
  const declared = resolvePolicy(input.policy, { ...context, path, value: input.value });
  const effective = override?.policy ?? declared ?? input.fallback ?? "required";
  if (effective === "droppable") {
    return {
      action: "drop",
      path,
      record: {
        phase: context.phase,
        path,
        sourceFormat: context.inputFormat,
        targetFormat: context.outputFormat,
        cause,
        authorization: override ? "override_droppable" : "policy_droppable",
      },
    };
  }
  throw nonDroppableFieldError(context, path);
}

/** Structural decisions of one projection pass (no field values retained). */
export interface ProjectionPlan {
  readonly context: ProjectionContext;
  readonly overrides: readonly PolicyOverride[];
  readonly decisions: readonly FieldDecision[];
  readonly drops: readonly DropRecord[];
  readonly adaptations: readonly FeatureAdaptationRecord[];
}

/**
 * Stateful, context-bound decision recorder. One instance per projection pass.
 * A mid-walk throw leaves `snapshot()` with the drops already recorded, so the
 * pipeline can settle "as it happened" (§6.5).
 */
export class ProjectionPlanner {
  private readonly decisions: FieldDecision[] = [];
  private readonly drops: DropRecord[] = [];
  private readonly adaptations: FeatureAdaptationRecord[] = [];
  private readonly overrides: readonly PolicyOverride[];

  constructor(
    readonly context: ProjectionContext,
    overrides: readonly PolicyOverride[] = [],
  ) {
    for (const override of overrides) validateOverride(override);
    this.overrides = overrides;
  }

  decide(input: Omit<DecideFieldInput, "context" | "overrides">): FieldDecision {
    const decision = decideField({ ...input, context: this.context, overrides: this.overrides });
    this.push(decision);
    return decision;
  }

  rendered(path: string, value: unknown, policy?: FieldPolicy): FieldDecision {
    return this.decide({ path, value, policy, outcome: { kind: "rendered" } });
  }

  transformed(path: string, value: unknown, policy?: FieldPolicy): FieldDecision {
    return this.decide({ path, value, policy, outcome: { kind: "transformed" } });
  }

  /** Record an explicitly authorized feature adaptation (never EXACT on render). */
  adapt(
    path: string,
    value: unknown,
    policy: FieldPolicy | undefined,
    feature: string,
    lossy: boolean,
  ): FieldDecision {
    return this.decide({
      path,
      value,
      policy,
      outcome: { kind: "adapted", lossy },
      adaptation: { feature, authorized: true, lossy },
    });
  }

  unsupported(
    path: string,
    value: unknown,
    policy: FieldPolicy | undefined,
    cause: DropRecord["cause"],
    adaptation?: FieldAdaptationAuthorization,
  ): FieldDecision {
    return this.decide({
      path,
      value,
      policy,
      outcome: { kind: "unsupported", cause },
      ...(adaptation ? { adaptation } : {}),
    });
  }

  snapshot(): ProjectionPlan {
    return {
      context: this.context,
      overrides: this.overrides,
      decisions: [...this.decisions],
      drops: [...this.drops],
      adaptations: [...this.adaptations],
    };
  }

  private push(decision: FieldDecision): void {
    this.decisions.push(decision);
    if (decision.action === "drop") this.drops.push(decision.record);
    else if (decision.action === "adapt") this.adaptations.push(decision.record);
  }
}

/**
 * Re-run one execute pass and assert it made the exact same structural
 * decisions as the plan (§6.5, E-9): the semantic fields a plan depends on must
 * not change between passes (e.g. privacy restore must not alter structure).
 */
export function executePlan<T>(
  plan: ProjectionPlan,
  run: (planner: ProjectionPlanner) => T,
): T {
  const planner = new ProjectionPlanner(plan.context, plan.overrides);
  const value = run(planner);
  assertPlanStable(plan, planner.snapshot());
  return value;
}

export function assertPlanStable(expected: ProjectionPlan, actual: ProjectionPlan): void {
  if (expected.decisions.length !== actual.decisions.length) {
    throw validationError(
      `projection plan changed between execute passes (${expected.decisions.length} -> ${actual.decisions.length})`,
    );
  }
  for (let i = 0; i < expected.decisions.length; i++) {
    const before = expected.decisions[i];
    const after = actual.decisions[i];
    if (before.path !== after.path || before.action !== after.action) {
      throw validationError(
        `projection plan changed at ${before.path}: ${before.action} -> ${after.action}`,
      );
    }
    if (before.action === "drop" && after.action === "drop") {
      if (
        before.record.cause !== after.record.cause ||
        before.record.authorization !== after.record.authorization
      ) {
        throw validationError(`projection drop record changed at ${before.path}`);
      }
    } else if (before.action === "adapt" && after.action === "adapt") {
      if (before.record.feature !== after.record.feature || before.record.lossy !== after.record.lossy) {
        throw validationError(`projection adaptation changed at ${before.path}`);
      }
    }
  }
}
