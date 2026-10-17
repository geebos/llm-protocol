/**
 * Projection Planner contract tests (docs/07.ir-native-codec.md §6, P2).
 *
 * Covers the four-state adjudication, policy/override handling, Plan/Execute
 * stability, and mid-walk settlement.
 */
import { describe, expect, it } from "vitest";
import {
  ProjectionPlanner,
  assertPlanStable,
  decideField,
  executePlan,
  nonDroppableFieldError,
} from "../../src/ir/projection/planner.js";
import { validateOverride } from "../../src/ir/projection/override.js";
import { calculateFidelity } from "../../src/ir/projection/fidelity.js";
import { projectionContext } from "../../src/ir/projection/context.js";
import { anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";
import type { FieldPolicy } from "../../src/ir/policy/policy.js";

const context = (phase: "request" | "response" | "stream" = "request") =>
  projectionContext(
    phase,
    "anthropic-messages",
    "openai-chat",
    anthropicDefaultProfile,
    openaiChatDefaultProfile,
  );

const base = {
  context: context(),
  path: "native.anthropic.topK",
  value: 5,
} as const;

describe("four-state adjudication (P2)", () => {
  it("keeps rendered and transformed fields", () => {
    expect(decideField({ ...base, policy: "required", outcome: { kind: "rendered" } })).toEqual({
      action: "keep",
      path: base.path,
      state: "rendered",
    });
    expect(decideField({ ...base, policy: "required", outcome: { kind: "transformed" } })).toEqual({
      action: "keep",
      path: base.path,
      state: "transformed",
    });
  });

  it("drops an unsupported droppable field", () => {
    const decision = decideField({
      ...base,
      policy: "droppable",
      outcome: { kind: "unsupported", cause: "unsupported_by_target" },
    });
    expect(decision).toMatchObject({
      action: "drop",
      record: {
        phase: "request",
        sourceFormat: "anthropic-messages",
        targetFormat: "openai-chat",
        cause: "unsupported_by_target",
        authorization: "policy_droppable",
      },
    });
  });

  it("throws for an unsupported required field (fail-closed)", () => {
    expect(() =>
      decideField({
        ...base,
        policy: "required",
        outcome: { kind: "unsupported", cause: "unsupported_by_target" },
      }),
    ).toThrowError(nonDroppableFieldError(base.context, base.path));
  });

  it("fails closed when no policy is declared", () => {
    expect(() =>
      decideField({
        ...base,
        policy: undefined,
        outcome: { kind: "unsupported", cause: "unknown_field" },
      }),
    ).toThrow();
  });

  it("honours a declared fallback policy", () => {
    const decision = decideField({
      ...base,
      policy: undefined,
      fallback: "droppable",
      outcome: { kind: "unsupported", cause: "unknown_field" },
    });
    expect(decision.action).toBe("drop");
  });

  it("resolves a value-dependent policy", () => {
    const policy: FieldPolicy = ({ value }) =>
      typeof value === "number" && value > 1 ? "required" : "droppable";
    expect(
      decideField({ ...base, value: 1, policy, outcome: { kind: "unsupported", cause: "unsupported_by_target" } })
        .action,
    ).toBe("drop");
    expect(() =>
      decideField({ ...base, value: 3, policy, outcome: { kind: "unsupported", cause: "unsupported_by_target" } }),
    ).toThrow();
  });
});

describe("feature adaptation vs projection policy (P2, §6.2.1)", () => {
  it("records an authorized adaptation and never reports EXACT", () => {
    const planner = new ProjectionPlanner(context());
    planner.adapt("cache", { type: "ephemeral" }, "required", "cache_affinity", false);
    const plan = planner.snapshot();
    expect(plan.adaptations).toEqual([
      expect.objectContaining({ feature: "cache_affinity", lossy: false }),
    ]);
    expect(calculateFidelity([], plan.drops, plan.adaptations)).toBe("COMPATIBLE");
    expect(calculateFidelity([], plan.drops, [{ ...plan.adaptations[0], lossy: true }])).toBe("LOSSY");
  });

  it("falls back to applyPolicy when adaptation is not authorized", () => {
    const decision = decideField({
      ...base,
      policy: "droppable",
      outcome: { kind: "adapted", lossy: true },
      adaptation: { feature: "cache_affinity", authorized: false, lossy: true },
    });
    expect(decision).toMatchObject({
      action: "drop",
      record: { cause: "unrepresentable", authorization: "policy_droppable" },
    });
  });
});

describe("policy overrides (§5.9)", () => {
  it("relaxes required -> droppable and records override authorization", () => {
    const planner = new ProjectionPlanner(context(), [
      { path: base.path, inputFormat: "anthropic-messages", outputFormat: "openai-chat", policy: "droppable" },
    ]);
    const decision = planner.unsupported(base.path, base.value, "required", "unsupported_by_target");
    expect(decision).toMatchObject({
      action: "drop",
      record: { authorization: "override_droppable" },
    });
  });

  it("does not apply an override scoped to another direction", () => {
    const planner = new ProjectionPlanner(context(), [
      { path: base.path, inputFormat: "openai-chat", policy: "droppable" },
    ]);
    expect(() =>
      planner.unsupported(base.path, base.value, "required", "unsupported_by_target"),
    ).toThrow();
  });

  it("rejects an override that relaxes a hard-required field", () => {
    expect(() =>
      validateOverride({ path: "messages[0].content[1].reasoning.signature", policy: "droppable" }),
    ).toThrow(/hard segment/);
    expect(() =>
      new ProjectionPlanner(context(), [{ path: "opaque_native", policy: "droppable" }]),
    ).toThrow();
  });
});

describe("settlement and Plan/Execute (P2, §6.5)", () => {
  it("keeps drops already recorded when a later field throws", () => {
    const planner = new ProjectionPlanner(context());
    planner.unsupported("a", 1, "droppable", "unsupported_by_target");
    expect(() => planner.unsupported("b", 2, "required", "unsupported_by_target")).toThrow();
    const plan = planner.snapshot();
    expect(plan.drops.map((d) => d.path)).toEqual(["a"]);
  });

  it("accepts a stable execute pass", () => {
    const planner = new ProjectionPlanner(context());
    planner.rendered("a", 1);
    const plan = planner.snapshot();
    const value = executePlan(plan, (p) => {
      p.rendered("a", 1);
      return "done";
    });
    expect(value).toBe("done");
  });

  it("rejects an execute pass that changes structure", () => {
    const planner = new ProjectionPlanner(context());
    planner.rendered("a", 1);
    const plan = planner.snapshot();
    expect(() =>
      executePlan(plan, (p) => {
        p.rendered("a", 1);
        p.rendered("b", 2);
      }),
    ).toThrow(/changed between execute passes/);
  });

  it("rejects a drop record that changed authorization", () => {
    const planner = new ProjectionPlanner(context(), [
      { path: "a", policy: "droppable" },
    ]);
    planner.unsupported("a", 1, "required", "unsupported_by_target");
    const plan = planner.snapshot();
    const other = new ProjectionPlanner(context());
    other.unsupported("a", 1, "droppable", "unsupported_by_target");
    expect(() => assertPlanStable(plan, other.snapshot())).toThrow(
      /drop record changed/,
    );
  });
});
