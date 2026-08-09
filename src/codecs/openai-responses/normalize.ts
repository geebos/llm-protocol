/**
 * Tool registries + target-side normalization (responses.md §10.3/§10.4).
 *
 * Two registries live on the CodecContext (D-3):
 * - Tool Definition Registry: indexed by *normalized tool name*, populated at
 *   definition time (no call_id exists yet);
 * - Tool Call Registry: double-indexed by call_id and item_id, populated when a
 *   call is first encountered (input function_call / response tool_use).
 *
 * The `executionKind` (function/custom) and `nameKind` (plain/namespaced) are
 * orthogonal: namespace flattening never changes the payload shape.
 *
 * Responses does NOT require call/result adjacency (v0.5, P0-4): only a unique
 * call_id pairing, preserving source order. Heavier normalization (Messages
 * adjacency / Chat role=tool adjacency) stays in the respective target
 * renderers; this module only enforces the unique-pairing invariant.
 */
import type { CodecContext } from "../protocol-adapter.js";
import {
  ensureToolCallRegistry,
  ensureToolDefinitionRegistry,
  type ToolCallEntry,
  type ToolDefEntry,
} from "../protocol-adapter.js";
import { unsupportedError } from "../../errors.js";
import type { CanonicalMessage } from "../../ir/types.js";

/** Register a tool definition; rejects flatten collisions (no ambiguous routes). */
export function registerToolDefinition(
  ctx: CodecContext,
  entry: ToolDefEntry,
): void {
  const reg = ensureToolDefinitionRegistry(ctx);
  const existing = reg.map.get(entry.normalizedName);
  if (existing !== undefined && existing.originalName !== entry.originalName) {
    throw unsupportedError(
      `Tool name collision after namespace flattening: "${entry.normalizedName}" maps to both "${existing.originalName}" and "${entry.originalName}"`,
    );
  }
  reg.map.set(entry.normalizedName, entry);
}

/** Register a tool call under call_id (+ optional item ids, double index). */
export function registerToolCall(
  ctx: CodecContext,
  callId: string,
  entry: ToolCallEntry,
): void {
  const reg = ensureToolCallRegistry(ctx);
  if (reg.byCallId.has(callId)) {
    throw unsupportedError(`Duplicate call_id "${callId}" in the same request`);
  }
  reg.byCallId.set(callId, entry);
  if (entry.sourceItemId !== undefined) {
    reg.byItemId.set(entry.sourceItemId, entry);
  }
  if (entry.targetItemId !== undefined) {
    reg.byItemId.set(entry.targetItemId, entry);
  }
}

export function resolveDefinition(
  ctx: CodecContext,
  normalizedName: string,
): ToolDefEntry | undefined {
  return ensureToolDefinitionRegistry(ctx).map.get(normalizedName);
}

export function resolveCallByCallId(
  ctx: CodecContext,
  callId: string,
): ToolCallEntry | undefined {
  return ensureToolCallRegistry(ctx).byCallId.get(callId);
}

export function resolveCallByItemId(
  ctx: CodecContext,
  itemId: string,
): ToolCallEntry | undefined {
  return ensureToolCallRegistry(ctx).byItemId.get(itemId);
}

/**
 * Responses-side normalization: minimal and order-preserving.
 *
 * Responses accepts non-adjacent call/result pairs as long as each result has
 * a unique call_id; no reordering is performed (v0.5, P0-4). Runs of adjacent
 * same-role items are merged per §3.3 (a message may carry text and tool calls
 * together). Nothing is deleted or moved here.
 */
export function normalizeForResponses(messages: CanonicalMessage[]): CanonicalMessage[] {
  const merged: CanonicalMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      merged.push({ role: m.role, content: [...m.content] });
    }
  }
  return merged;
}
