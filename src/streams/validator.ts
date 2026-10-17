/**
 * Canonical stream invariant validator (SR-002, 7.2).
 *
 * Enforces, in order:
 * - `message_start` precedes all content events and appears at most once;
 * - every block start/delta/end uses the same (choice, kind, content) key;
 * - `message_end` appears at most once and is a terminal transition;
 * - only one terminal transition (error/end) per stream.
 *
 * Blocks are keyed with the unified `StreamBlockKey` (docs/07 §7.1, DEC-13) so
 * multi-candidate streams never alias two choices onto one key. Index-based
 * events default `choice` to 0; location-based events (refusal) resolve the key
 * at the parser boundary via `createStreamBlockKey`.
 */
import type { CanonicalStreamEvent } from "./types.js";
import type { CanonicalError } from "../errors.js";
import {
  createStreamBlockKey,
  streamBlockKeyId,
  type StreamBlockKey,
} from "../ir/stream-key.js";

function protocolError(message: string): CanonicalError {
  return { kind: "stream_protocol", message };
}

export class StreamValidator {
  private messageStarted = false;
  private messageEnded = false;
  private terminal = false;
  private readonly blocks = new Map<string, StreamBlockKey["kind"]>();
  private readonly ended = new Set<string>();
  private readonly startedChoices = new Set<number>();
  private readonly endedChoices = new Set<number>();

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

      case "choice_start":
        if (!this.messageStarted) {
          return { type: "error", error: protocolError("choice_start before message_start") };
        }
        if (this.startedChoices.has(event.choice)) {
          return { type: "error", error: protocolError("duplicate choice_start") };
        }
        this.startedChoices.add(event.choice);
        return event;

      case "choice_end":
        if (!this.startedChoices.has(event.choice)) {
          return { type: "error", error: protocolError("choice_end for unstarted choice") };
        }
        if (this.endedChoices.has(event.choice)) {
          return { type: "error", error: protocolError("duplicate choice_end") };
        }
        this.endedChoices.add(event.choice);
        return event;

      case "text_start":
        return this.startGuard(event, createStreamBlockKey("text", event.location));
      case "tool_start":
        return this.startGuard(event, createStreamBlockKey("tool", event.location));
      case "reasoning_start":
        return this.startGuard(event, createStreamBlockKey("reasoning", event.location));
      case "refusal_start":
        return this.startGuard(event, createStreamBlockKey("refusal", event.location));

      case "text_delta":
        return this.deltaGuard(event, createStreamBlockKey("text", event.location));
      case "tool_arguments_delta":
        return this.deltaGuard(event, createStreamBlockKey("tool", event.location));
      case "reasoning_delta":
        return this.deltaGuard(event, createStreamBlockKey("reasoning", event.location));
      case "refusal_delta":
        return this.deltaGuard(event, createStreamBlockKey("refusal", event.location));

      case "text_end":
        return this.endGuard(event, createStreamBlockKey("text", event.location));
      case "tool_end":
        return this.endGuard(event, createStreamBlockKey("tool", event.location));
      case "reasoning_end":
        return this.endGuard(event, createStreamBlockKey("reasoning", event.location));
      case "refusal_end":
        return this.endGuard(event, createStreamBlockKey("refusal", event.location));

      case "choice_metadata":
        if (!this.messageStarted) {
          return { type: "error", error: protocolError("choice_metadata before message_start") };
        }
        return event;

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

  private startGuard(
    event: CanonicalStreamEvent,
    key: StreamBlockKey,
  ): CanonicalStreamEvent {
    if (!this.messageStarted) {
      return { type: "error", error: protocolError(`${event.type} before message_start`) };
    }
    if (this.messageEnded) {
      return { type: "error", error: protocolError(`${event.type} after message_end`) };
    }
    if (this.endedChoices.has(key.choice)) {
      return { type: "error", error: protocolError(`${event.type} after choice_end`) };
    }
    this.startedChoices.add(key.choice);
    const id = streamBlockKeyId(key);
    if (this.blocks.has(id)) {
      return {
        type: "error",
        error: protocolError(`duplicate ${event.type} for block ${id}`),
      };
    }
    this.blocks.set(id, key.kind);
    return event;
  }

  private deltaGuard(
    event: CanonicalStreamEvent,
    key: StreamBlockKey,
  ): CanonicalStreamEvent {
    const id = streamBlockKeyId(key);
    if (this.endedChoices.has(key.choice)) {
      return { type: "error", error: protocolError(`${event.type} after choice_end`) };
    }
    if (!this.blocks.has(id)) {
      return { type: "error", error: protocolError(`${event.type} for unstarted block ${id}`) };
    }
    if (this.ended.has(id)) {
      return {
        type: "error",
        error: protocolError(`${event.type} after block end (block ${id})`),
      };
    }
    return event;
  }

  private endGuard(
    event: CanonicalStreamEvent,
    key: StreamBlockKey,
  ): CanonicalStreamEvent {
    const id = streamBlockKeyId(key);
    if (this.endedChoices.has(key.choice)) {
      return { type: "error", error: protocolError(`${event.type} after choice_end`) };
    }
    if (!this.blocks.has(id)) {
      return { type: "error", error: protocolError(`${event.type} for unstarted block ${id}`) };
    }
    if (this.ended.has(id)) {
      return { type: "error", error: protocolError(`duplicate ${event.type} (block ${id})`) };
    }
    this.ended.add(id);
    return event;
  }
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
