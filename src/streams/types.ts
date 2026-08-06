/**
 * Canonical Stream Event (7.1).
 *
 * The single intermediate representation for streaming translation. Both
 * protocols' SSE parse into these events and render from these events.
 * `index` identifies a content/tool/reasoning block *within the protocol that
 * produced the events*; renderers keep their own output index space and map by
 * (kind, index) so ordering across protocols is preserved (TH-006).
 */
import type { CanonicalUsage } from "../ir/usage.js";
import type { CanonicalFinishReason } from "../ir/finish-reason.js";
import type { CanonicalError } from "../errors.js";

export type CanonicalStreamEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; text: string }
  | { type: "text_end"; index: number }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_arguments_delta"; index: number; partialJson: string }
  | { type: "tool_end"; index: number }
  | { type: "reasoning_start"; index: number; metadata?: unknown }
  | { type: "reasoning_delta"; index: number; text?: string; opaque?: string }
  | { type: "reasoning_end"; index: number; metadata?: unknown }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "message_end"; finishReason?: CanonicalFinishReason }
  | { type: "error"; error: CanonicalError }
  | { type: "unknown"; sourceType: string; raw: unknown };

export function isCanonicalStreamEvent(v: unknown): v is CanonicalStreamEvent {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string"
  );
}
