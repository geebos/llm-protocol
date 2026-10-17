/**
 * Tool Interaction Projection (docs/07 §5.2.1 E-2).
 *
 * Separate from Role Projection: role governs permission/order, tool projection
 * governs call/result association. Tool results must reference a tool call that
 * exists in the same request; when that association cannot be guaranteed the
 * projection is fail-closed rather than silently reordered.
 */
import type { ApiFormat } from "../../formats.js";
import type { CanonicalMessage } from "../types.js";
import { fieldProjectionError } from "./role.js";

/** Throw when a `tool_result` references no `tool_call` in the same request. */
export function assertToolPairing(
  messages: CanonicalMessage[],
  targetFormat: ApiFormat,
): void {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") callIds.add(part.id);
    }
  }
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_result" && !callIds.has(part.toolCallId)) {
        throw fieldProjectionError("tool_result.toolCallId", targetFormat);
      }
    }
  }
}
