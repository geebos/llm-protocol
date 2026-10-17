/**
 * Field-level droppability policy infrastructure (docs/07.ir-native-codec.md §5.7).
 *
 * `PolicyFor<T>` is type-bound to the IR type so a missing field is a compile
 * error (`satisfies PolicyFor<T>`), unlike a loose index signature.
 */
import type { ApiFormat } from "../../formats.js";
import type { ProjectionContext } from "../projection/context.js";

export type DropPolicy = "droppable" | "required";

/**
 * Field policy context = projection context + the field being judged. It extends
 * `ProjectionContext` so `inputFormat/outputFormat` mean the same thing here and
 * in the Planner (docs/07 §5.7 / §6.1).
 */
export interface FieldPolicyContext extends ProjectionContext {
  path: string;
  value: unknown;
}

export type FieldPolicy = DropPolicy | ((ctx: FieldPolicyContext) => DropPolicy);

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * A node is a leaf (`FieldPolicy`) for primitives, index-signature records and
 * arrays; structured objects recurse but may also be declared as one leaf.
 *
 * Known limitation: union element handling is coarse (an array of objects is
 * treated as a leaf). Refine when a native field actually needs element-level
 * policy.
 */
type PolicyNode<T> = NonNullable<T> extends Primitive
  ? FieldPolicy
  : string extends keyof NonNullable<T>
    ? FieldPolicy
    : NonNullable<T> extends readonly unknown[]
      ? FieldPolicy
      : NonNullable<T> extends object
        ? PolicyFor<NonNullable<T>> | FieldPolicy
        : FieldPolicy;

export type PolicyFor<T> = {
  [K in keyof Required<T>]-?: PolicyNode<T[K]>;
};
