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
import type { ResolvedStreamLocation } from "../ir/stream-key.js";
import type { NativeChoiceStreamMetadata, NativeStream } from "../ir/native/index.js";

export type CanonicalStreamEvent =
  | { type: "message_start"; id?: string; model?: string; native?: NativeStream }
  | { type: "choice_start"; choice: number; native?: NativeStream }
  | { type: "choice_end"; choice: number; finishReason?: CanonicalFinishReason; native?: NativeStream }
  | { type: "text_start"; location: ResolvedStreamLocation }
  | { type: "text_delta"; location: ResolvedStreamLocation; text: string }
  | { type: "text_end"; location: ResolvedStreamLocation }
  | { type: "tool_start"; location: ResolvedStreamLocation; id: string; name: string }
  | { type: "tool_arguments_delta"; location: ResolvedStreamLocation; partialJson: string }
  | { type: "tool_end"; location: ResolvedStreamLocation }
  | { type: "reasoning_start"; location: ResolvedStreamLocation; metadata?: unknown }
  | { type: "reasoning_delta"; location: ResolvedStreamLocation; text?: string; opaque?: string }
  | { type: "reasoning_end"; location: ResolvedStreamLocation; metadata?: unknown }
  | { type: "refusal_start"; location: ResolvedStreamLocation }
  | { type: "refusal_delta"; location: ResolvedStreamLocation; text: string }
  | { type: "refusal_end"; location: ResolvedStreamLocation }
  | { type: "choice_metadata"; choice: number; native: NativeChoiceStreamMetadata }
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
