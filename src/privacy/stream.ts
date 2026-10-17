/**
 * Streaming restore transform (§8.2, §9).
 *
 * Registered matches use Maximal Munch across chunks; tool arguments are
 * restored incrementally by a JSON-aware state machine that forwards every
 * confirmed byte immediately and only withholds a bounded tail (§8.4).
 * Lifecycle events (`message_start/end`, `*_start/*_end` pairing) are preserved
 * exactly; only delta count/content/boundaries may change (INV-6).
 *
 * Buffers are keyed by the unified `StreamBlockKey` (docs/07 §7.1/§8.3), never a
 * bare index, so two choices at the same content index never share a buffer.
 */
import type { CanonicalStreamEvent } from "../streams/types.js";
import type { ResolvedStreamLocation } from "../ir/stream-key.js";
import { createStreamBlockKey, streamBlockKeyId } from "../ir/stream-key.js";
import type { ResolvedPrivacyConfig } from "./config.js";
import { PrivacyGuardError } from "./errors.js";
import { createToolArgumentsRestorer, type ToolArgumentsRestorer } from "./json-stream.js";
import { restoreText } from "./restore.js";
import { createPlaceholderMatcher } from "./trie.js";
import type { PrivacyWarning } from "./types.js";
import type { PrivacySession } from "./session.js";

export interface StreamRestoreStats {
  restored: number;
  unknown: number;
  overflowed: boolean;
  jsonParseFailures: number;
}

export interface StreamRestoreHandle {
  stream: TransformStream<CanonicalStreamEvent, CanonicalStreamEvent>;
  stats: StreamRestoreStats;
  /** Drop state and release the session reference on cancellation. */
  abort(): void;
}

interface PendingText {
  location: ResolvedStreamLocation;
  text: string;
  kind: "text" | "refusal";
}

interface ToolBlock {
  restorer: ToolArgumentsRestorer;
}

function blockKey(kind: "text" | "tool" | "refusal", location: ResolvedStreamLocation): string {
  return streamBlockKeyId(createStreamBlockKey(kind, location));
}

export function createPrivacyStreamRestore(
  session: PrivacySession,
  config: ResolvedPrivacyConfig,
  report: (warning: PrivacyWarning) => void,
): StreamRestoreHandle {
  const stats: StreamRestoreStats = {
    restored: 0,
    unknown: 0,
    overflowed: false,
    jsonParseFailures: 0,
  };
  const entries = session.snapshot();
  const matcher = createPlaceholderMatcher(config.template, entries);
  const pendingText = new Map<string, PendingText>();
  const toolBlocks = new Map<string, ToolBlock>();
  let released = false;
  session.acquireStream();
  const release = (): void => {
    if (!released) {
      released = true;
      session.releaseStream();
    }
  };

  const stream = new TransformStream<CanonicalStreamEvent, CanonicalStreamEvent>({
    transform(event, controller) {
      switch (event.type) {
        case "text_start":
          pendingText.set(blockKey("text", event.location), {
            location: event.location,
            text: "",
            kind: "text",
          });
          controller.enqueue(event);
          break;
        case "text_delta": {
          const key = blockKey("text", event.location);
          const pending = (pendingText.get(key)?.text ?? "") + event.text;
          pendingText.set(key, { location: event.location, text: pending, kind: "text" });
          processText("text", event.location, false, controller);
          break;
        }
        case "text_end":
          processText("text", event.location, true, controller);
          pendingText.delete(blockKey("text", event.location));
          controller.enqueue(event);
          break;
        case "refusal_start":
          pendingText.set(blockKey("refusal", event.location), {
            location: event.location,
            text: "",
            kind: "refusal",
          });
          controller.enqueue(event);
          break;
        case "refusal_delta": {
          const key = blockKey("refusal", event.location);
          const pending = (pendingText.get(key)?.text ?? "") + event.text;
          pendingText.set(key, { location: event.location, text: pending, kind: "refusal" });
          processText("refusal", event.location, false, controller);
          break;
        }
        case "refusal_end":
          processText("refusal", event.location, true, controller);
          pendingText.delete(blockKey("refusal", event.location));
          controller.enqueue(event);
          break;
        case "tool_start":
          toolBlocks.set(blockKey("tool", event.location), {
            restorer: createToolArgumentsRestorer({
              compiled: config.template,
              matcher,
              maxPlaceholderLength: config.streaming.maxPlaceholderLength,
              escape: config.escape,
              maxBytes: config.streaming.maxToolArgumentBytes,
              overflowAction: config.streaming.overflowAction,
              stats,
              report,
            }),
          });
          controller.enqueue(event);
          break;
        case "tool_arguments_delta": {
          const block = toolBlocks.get(blockKey("tool", event.location));
          if (!block) {
            controller.enqueue(event);
            break;
          }
          emitToolArguments(controller, event.location, () =>
            block.restorer.feed(event.partialJson),
          );
          break;
        }
        case "tool_end": {
          const key = blockKey("tool", event.location);
          const block = toolBlocks.get(key);
          toolBlocks.delete(key);
          if (block) {
            emitToolArguments(controller, event.location, () => block.restorer.end());
          }
          controller.enqueue(event);
          break;
        }
        case "error":
          pendingText.clear();
          for (const block of toolBlocks.values()) block.restorer.abort();
          toolBlocks.clear();
          release();
          controller.enqueue(event);
          break;
        case "message_end": {
          for (const entry of [...pendingText.values()]) {
            processText(entry.kind, entry.location, true, controller);
          }
          pendingText.clear();
          for (const block of toolBlocks.values()) block.restorer.abort();
          toolBlocks.clear();
          release();
          controller.enqueue(event);
          break;
        }
        default:
          controller.enqueue(event);
          break;
      }
    },
    flush(controller) {
      for (const entry of [...pendingText.values()]) {
        processText(entry.kind, entry.location, true, controller);
      }
      pendingText.clear();
      for (const block of toolBlocks.values()) block.restorer.abort();
      toolBlocks.clear();
      release();
      void controller;
    },
  });

  /** Emit the restorer fragments, releasing the session if it throws. */
  function emitToolArguments(
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
    location: ResolvedStreamLocation,
    run: () => string[],
  ): void {
    let fragments: string[];
    try {
      fragments = run();
    } catch (err) {
      release();
      throw err;
    }
    for (const fragment of fragments) {
      if (!fragment) continue;
      controller.enqueue({
        type: "tool_arguments_delta",
        location,
        partialJson: fragment,
      });
    }
  }

  function emitText(
    kind: "text" | "refusal",
    location: ResolvedStreamLocation,
    text: string,
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (!text) return;
    if (kind === "refusal") {
      controller.enqueue({ type: "refusal_delta", location, text });
    } else {
      controller.enqueue({ type: "text_delta", location, text });
    }
  }

  function processText(
    kind: "text" | "refusal",
    location: ResolvedStreamLocation,
    final: boolean,
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    const key = blockKey(kind, location);
    const pending = pendingText.get(key)?.text ?? "";
    if (pending.length > config.streaming.maxTextPendingBytes) {
      handleOverflow(pending, kind, location, controller);
      pendingText.set(key, { location, text: "", kind });
      return;
    }
    const result = restoreText(pending, matcher, config.template, {
      final,
      maxPlaceholderLength: config.streaming.maxPlaceholderLength,
      escape: config.escape,
    });
    emitText(kind, location, result.out, controller);
    stats.restored += result.matched;
    stats.unknown += result.unknown;
    for (const w of result.warnings) report(w);
    if (final && result.rest) {
      // Stream ended with an incomplete placeholder prefix: emit as-is
      // (strict default) and warn, or abort under strictStreaming.
      if (config.streaming.strictStreaming) {
        release();
        throw new PrivacyGuardError(
          "privacy_unknown_placeholder",
          "Stream ended with an incomplete placeholder",
        );
      }
      report({
        code: "privacy_unknown_placeholder",
        message: "Stream ended with an incomplete placeholder prefix",
      });
      emitText(kind, location, result.rest, controller);
      pendingText.set(key, { location, text: "", kind });
      return;
    }
    pendingText.set(key, { location, text: result.rest, kind });
  }

  function handleOverflow(
    pending: string,
    kind: "text" | "refusal",
    location: ResolvedStreamLocation,
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    stats.overflowed = true;
    if (config.streaming.overflowAction === "reject") {
      release();
      throw new PrivacyGuardError(
        "privacy_buffer_overflow",
        `Privacy ${kind} buffer exceeded its limit`,
      );
    }
    report({
      code: "privacy_buffer_overflow",
      message: `Privacy ${kind} buffer overflowed; buffered content flushed raw`,
    });
    emitText(kind, location, pending, controller);
  }

  return {
    stream,
    stats,
    abort(): void {
      pendingText.clear();
      for (const block of toolBlocks.values()) block.restorer.abort();
      toolBlocks.clear();
      release();
    },
  };
}
