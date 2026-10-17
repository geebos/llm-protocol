/**
 * Response-side restoration (§8.1).
 *
 * Only client-facing text and tool-argument string values are restored.
 * Reasoning and opaque fields are never rewritten (signature protection).
 */
import type { CanonicalResponse } from "../ir/response.js";
import type { ContentPart } from "../ir/types.js";
import { restoreJsonText, restoreString } from "./restore.js";
import type { PrivacySession } from "./session.js";
import type { PrivacyWarning } from "./types.js";
import type { CompiledTemplate } from "./template.js";

export interface RestoreCounts {
  restored: number;
  unknown: number;
  jsonParseFailures: number;
  warnings: PrivacyWarning[];
}

/** Restore client-facing text in a canonical response (mutates in place). */
export function restoreResponse(
  response: CanonicalResponse,
  session: PrivacySession,
  template: CompiledTemplate,
  maxPlaceholderLength: number,
  maxToolArgumentBytes = 1024 * 1024,
): RestoreCounts {
  const entries = session.snapshot();
  const counts: RestoreCounts = {
    restored: 0,
    unknown: 0,
    jsonParseFailures: 0,
    warnings: [],
  };
  if (entries.length === 0) return counts;

  const restoreField = (value: string): string => {
    const result = restoreString(value, template, entries, maxPlaceholderLength);
    counts.unknown += result.unknown;
    counts.restored += result.matched;
    counts.warnings.push(...result.warnings);
    return result.text;
  };

  const walk = (parts: ContentPart[]): void => {
    for (const part of parts) {
      switch (part.type) {
        case "text":
          part.text = restoreField(part.text);
          break;
        case "refusal":
          // Refusal text is client-facing and restored like text (E-3).
          part.text = restoreField(part.text);
          break;
        case "tool_call": {
          if (part.argumentsText.length > maxToolArgumentBytes) {
            counts.warnings.push({
              code: "privacy_buffer_overflow",
              message: "Tool arguments exceed the restore limit and were left unrestored",
              field: "content.tool_call.arguments",
            });
            break;
          }
          const result = restoreJsonText(
            part.argumentsText,
            template,
            entries,
            maxPlaceholderLength,
          );
          if (result.parseFailed) {
            counts.jsonParseFailures++;
            counts.warnings.push({
              code: "privacy_json_parse_failed",
              message: "Tool arguments were not valid JSON and were left unrestored",
              field: "content.tool_call.arguments",
            });
          } else {
            part.argumentsText = result.text;
            counts.unknown += result.unknown;
            counts.restored += result.matched;
            counts.warnings.push(...result.warnings);
          }
          break;
        }
        case "tool_result":
          walk(part.content);
          break;
        case "annotation":
          // Only the display text; offsets/URLs/reference ids are untouched.
          if (part.text !== undefined) part.text = restoreField(part.text);
          break;
        case "image":
        case "file":
          // Binary/URL payloads are never rewritten by redaction.
          break;
        case "reasoning":
        case "opaque_native":
          // Opaque/reasoning fields are never rewritten (signature protection).
          break;
      }
    }
  };
  walk(response.choices.flatMap((choice) => choice.content));
  return counts;
}
