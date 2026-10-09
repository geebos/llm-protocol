/**
 * Streaming restore transform (§8.2, §9).
 *
 * Registered matches use Maximal Munch across chunks; tool arguments are
 * buffered until `tool_end` and restored JSON-aware. Lifecycle events
 * (`message_start/end`, `*_start/*_end` pairing, kind+index semantics) are
 * preserved exactly; only delta count/content/boundaries may change (INV-6).
 */
import type { CanonicalStreamEvent } from "../streams/types.js";
import type { ResolvedPrivacyConfig } from "./config.js";
import { PrivacyGuardError } from "./errors.js";
import { restoreJsonText, restoreText } from "./restore.js";
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
  const pendingText = new Map<number, string>();
  const pendingTool = new Map<number, string>();
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
          pendingText.set(event.index, "");
          controller.enqueue(event);
          break;
        case "text_delta": {
          const pending = (pendingText.get(event.index) ?? "") + event.text;
          pendingText.set(event.index, pending);
          processText(event.index, false, controller);
          break;
        }
        case "text_end":
          processText(event.index, true, controller);
          pendingText.delete(event.index);
          controller.enqueue(event);
          break;
        case "tool_start":
          pendingTool.set(event.index, "");
          controller.enqueue(event);
          break;
        case "tool_arguments_delta": {
          const pending = (pendingTool.get(event.index) ?? "") + event.partialJson;
          if (pending.length > config.streaming.maxToolArgumentBytes) {
            handleOverflow(pending, "tool_arguments", event.index, controller);
            pendingTool.set(event.index, "");
          } else {
            pendingTool.set(event.index, pending);
          }
          break;
        }
        case "tool_end": {
          const pending = pendingTool.get(event.index) ?? "";
          pendingTool.delete(event.index);
          if (pending) {
            const result = restoreJsonText(
              pending,
              config.template,
              entries,
              config.streaming.maxPlaceholderLength,
            );
            if (result.parseFailed) {
              stats.jsonParseFailures++;
              report({
                code: "privacy_json_parse_failed",
                message: "Buffered tool arguments were not valid JSON; left unrestored",
              });
              controller.enqueue({
                type: "tool_arguments_delta",
                index: event.index,
                partialJson: pending,
              });
            } else {
              stats.restored += result.matched;
              stats.unknown += result.unknown;
              for (const w of result.warnings) report(w);
              if (result.text !== "null" && result.text !== "") {
                controller.enqueue({
                  type: "tool_arguments_delta",
                  index: event.index,
                  partialJson: result.text,
                });
              }
            }
          }
          controller.enqueue(event);
          break;
        }
        case "error":
          pendingText.clear();
          pendingTool.clear();
          release();
          controller.enqueue(event);
          break;
        case "message_end": {
          for (const index of [...pendingText.keys()]) {
            processText(index, true, controller);
          }
          pendingText.clear();
          pendingTool.clear();
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
      for (const index of [...pendingText.keys()]) {
        processText(index, true, controller);
      }
      pendingText.clear();
      pendingTool.clear();
      release();
      void controller;
    },
  });

  function emitText(
    index: number,
    text: string,
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    if (text) {
      controller.enqueue({ type: "text_delta", index, text });
    }
  }

  function processText(
    index: number,
    final: boolean,
    controller: TransformStreamDefaultController<CanonicalStreamEvent>,
  ): void {
    const pending = pendingText.get(index) ?? "";
    if (pending.length > config.streaming.maxTextPendingBytes) {
      handleOverflow(pending, "text", index, controller);
      pendingText.set(index, "");
      return;
    }
    const result = restoreText(pending, matcher, config.template, {
      final,
      maxPlaceholderLength: config.streaming.maxPlaceholderLength,
    });
    emitText(index, result.out, controller);
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
      emitText(index, result.rest, controller);
      pendingText.set(index, "");
      return;
    }
    pendingText.set(index, result.rest);
  }

  function handleOverflow(
    pending: string,
    kind: string,
    index: number,
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
    if (kind === "text") {
      emitText(index, pending, controller);
    } else {
      controller.enqueue({
        type: "tool_arguments_delta",
        index,
        partialJson: pending,
      });
    }
  }

  return { stream, stats };
}
