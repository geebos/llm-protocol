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

/**
 * Multi-level stream location (responses.md §13.1.1, v0.4 P1-10).
 *
 * Replaces flat parallel indexes: output_index / content_index /
 * summary_index / annotation_index no longer share one `index` field.
 * Existing `index` on events remains as a compatibility alias equal to
 * `location.output.outputIndex`; new events/extensions use `location`.
 */
export type StreamLocation =
  | { kind: "output"; outputIndex: number }
  | { kind: "content"; outputIndex: number; contentIndex: number }
  | { kind: "summary"; outputIndex: number; summaryIndex: number }
  | {
      kind: "annotation";
      outputIndex: number;
      contentIndex: number;
      annotationIndex: number;
    }
  | { kind: "tool"; outputIndex: number; toolIndex: number };

export type CanonicalStreamEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "response_state"; state: "created" | "queued" | "in_progress"; metadata?: unknown }
  | { type: "text_start"; index: number; kind?: "text" | "refusal"; location?: StreamLocation }
  | { type: "text_delta"; index: number; text: string; kind?: "text" | "refusal"; location?: StreamLocation }
  | { type: "text_end"; index: number; kind?: "text" | "refusal"; location?: StreamLocation }
  | { type: "tool_start"; index: number; id: string; name: string; kind?: "function" | "custom"; location?: StreamLocation }
  | { type: "tool_arguments_delta"; index: number; partialJson: string; location?: StreamLocation }
  | { type: "tool_end"; index: number; location?: StreamLocation }
  | { type: "reasoning_start"; index: number; metadata?: unknown; location?: StreamLocation }
  | {
      type: "reasoning_delta";
      index: number;
      text?: string;
      opaque?: string;
      kind?: "summary" | "text";
      summaryIndex?: number;
      location?: StreamLocation;
    }
  | { type: "reasoning_end"; index: number; metadata?: unknown; location?: StreamLocation }
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
