/**
 * Field-policy application for codecs (docs/07 §6.2, §6.4).
 *
 * A codec declares, per field, what the target can express; this helper turns
 * that `ProjectionOutcome` into a keep / drop / throw using the Planner. Drops
 * are recorded on the codec context so the pipeline can report them.
 *
 * Standalone codec calls (no `ProjectionContext`) keep the legacy silent
 * behavior: only the pipeline decides policy, so unit-level codec tests do not
 * need a full context.
 */
import type { FieldPolicy } from "../policy/policy.js";
import type { ProjectionContext } from "./context.js";
import type { DropRecord } from "./drop-record.js";
import type { ProjectionOutcome } from "./outcome.js";
import type { PolicyOverride } from "./override.js";
import { decideField } from "./planner.js";

export interface ProjectionSink {
  projection?: ProjectionContext;
  drops?: DropRecord[];
}

export function applyFieldPolicy(
  sink: ProjectionSink,
  path: string,
  value: unknown,
  policy: FieldPolicy | undefined,
  outcome: ProjectionOutcome,
  overrides?: readonly PolicyOverride[],
): void {
  const context = sink.projection;
  if (!context) return;
  const decision = decideField({
    context,
    path,
    value,
    policy,
    outcome,
    overrides,
    fallback: "required",
  });
  if (decision.action === "drop") {
    (sink.drops ??= []).push(decision.record);
  }
}
