/**
 * Canonical stream invariant validator (SR-002, 7.2).
 *
 * Enforces, in order:
 * - `message_start` precedes all content events and appears at most once;
 * - every block start/delta/end uses the same (kind, index);
 * - `message_end` appears at most once and is a terminal transition;
 * - only one terminal transition (error/end) per stream.
 *
 * Violations surface as a `stream_protocol` error event rather than a crash.
 */
import type { CanonicalStreamEvent } from "./types.js";
import type { CanonicalError } from "../errors.js";

type BlockKind = "text" | "tool" | "reasoning";
type IndexedEvent = Extract<CanonicalStreamEvent, { index: number }>;

function protocolError(message: string): CanonicalError {
  return { kind: "stream_protocol", message };
}

function startKind(type: "text_start" | "tool_start" | "reasoning_start"): BlockKind {
  return type === "text_start" ? "text" : type === "tool_start" ? "tool" : "reasoning";
}

export class StreamValidator {
  private messageStarted = false;
  private messageEnded = false;
  private terminal = false;
  private readonly blocks = new Map<string, BlockKind>();
  private readonly ended = new Set<string>();

  /** Returns the validated event, an error event, or null to swallow. */
  accept(event: CanonicalStreamEvent): CanonicalStreamEvent {
    if (this.terminal) {
      // After a terminal transition no business events may follow.
      if (event.type === "error" || event.type === "message_end") return event;
      return { type: "error", error: protocolError("event after terminal transition") };
    }

    switch (event.type) {
      case "message_start":
        if (this.messageStarted) {
          return { type: "error", error: protocolError("duplicate message_start") };
        }
        this.messageStarted = true;
        return event;

      case "text_start":
      case "tool_start":
      case "reasoning_start": {
        if (!this.messageStarted) {
          return { type: "error", error: protocolError(`${event.type} before message_start`) };
        }
        if (this.messageEnded) {
          return { type: "error", error: protocolError(`${event.type} after message_end`) };
        }
        const key = blockKey(startKind(event.type), event.index);
        if (this.blocks.has(key)) {
          return { type: "error", error: protocolError(`duplicate ${event.type} for index ${event.index}`) };
        }
        this.blocks.set(key, startKind(event.type));
        return event;
      }

      case "text_delta":
        return this.deltaGuard(event, "text");
      case "tool_arguments_delta":
        return this.deltaGuard(event, "tool");
      case "reasoning_delta":
        return this.deltaGuard(event, "reasoning");

      case "text_end":
        return this.endGuard(event, "text");
      case "tool_end":
        return this.endGuard(event, "tool");
      case "reasoning_end":
        return this.endGuard(event, "reasoning");

      case "usage":
        if (!this.messageStarted) {
          return { type: "error", error: protocolError("usage before message_start") };
        }
        return event;

      case "message_end":
        if (this.messageEnded) {
          return { type: "error", error: protocolError("duplicate message_end") };
        }
        this.messageEnded = true;
        this.terminal = true;
        return event;

      case "error":
        this.terminal = true;
        return event;

      case "unknown":
        return event;
    }
  }

  private deltaGuard(event: IndexedEvent, kind: BlockKind): CanonicalStreamEvent {
    const key = blockKey(kind, event.index);
    if (!this.blocks.has(key)) {
      return { type: "error", error: protocolError(`${event.type} for unstarted index ${event.index}`) };
    }
    if (this.ended.has(key)) {
      return { type: "error", error: protocolError(`${event.type} after block end (index ${event.index})`) };
    }
    return event;
  }

  private endGuard(event: IndexedEvent, kind: BlockKind): CanonicalStreamEvent {
    const key = blockKey(kind, event.index);
    if (!this.blocks.has(key)) {
      return { type: "error", error: protocolError(`${event.type} for unstarted index ${event.index}`) };
    }
    if (this.ended.has(key)) {
      return { type: "error", error: protocolError(`duplicate ${event.type} (index ${event.index})`) };
    }
    this.ended.add(key);
    return event;
  }
}

function blockKey(kind: BlockKind, index: number): string {
  return `${kind}:${index}`;
}

/**
 * A TransformStream that passes canonical events through the validator,
 * converting violations into error events (never crashing).
 */
export function createCanonicalValidator(): TransformStream<
  CanonicalStreamEvent,
  CanonicalStreamEvent
> {
  const validator = new StreamValidator();
  return new TransformStream({
    transform(event, controller) {
      controller.enqueue(validator.accept(event));
    },
  });
}
