/**
 * Anthropic message-turn normalization (tech-v2.md P0-7 / 12).
 *
 * Anthropic Messages is stricter than OpenAI Chat about turn structure, most
 * notably `tool_result` placement: results must live inside a user turn and
 * come before ordinary text. This pass runs on canonical messages immediately
 * before the Anthropic renderer so that loose Chat-style sequences (separate
 * `tool` messages, consecutive user/assistant turns, text-before-result)
 * become well-formed Anthropic turns.
 *
 * Every normalization step is reported so the no-silent-downgrade rule holds.
 */
import type { CanonicalMessage, ContentPart } from "../../ir/types.js";
import type { CodecContext } from "../protocol-adapter.js";

/** Merge/normalize canonical messages into Anthropic-friendly turns. */
export function normalizeAnthropicTurns(
  messages: CanonicalMessage[],
  ctx: CodecContext,
): CanonicalMessage[] {
  const merged: CanonicalMessage[] = [];

  for (const m of messages) {
    const role = m.role === "tool" ? "user" : m.role;
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content.push(...m.content);
      ctx.warnings.push({
        code: "merged_consecutive_turns",
        message: `Merged consecutive ${role} turns into a single Anthropic turn`,
        fidelity: "COMPATIBLE",
        field: `messages.${role}`,
      });
    } else {
      merged.push({ role, content: [...m.content] });
    }
  }

  // Within each user turn, `tool_result` blocks come before text/image so a
  // result is never hidden behind unrelated user text (12.3 rule 3).
  for (const m of merged) {
    if (m.role !== "user") continue;
    const reordered = reorderToolResults(m.content, ctx);
    if (reordered) m.content = reordered;
  }

  return merged;
}

function reorderToolResults(
  parts: ContentPart[],
  ctx: CodecContext,
): ContentPart[] | undefined {
  const firstNonResult = parts.findIndex((p) => p.type !== "tool_result");
  const firstResult = parts.findIndex((p) => p.type === "tool_result");
  if (firstResult === -1) return undefined;
  if (firstNonResult === -1 || firstNonResult > firstResult) return undefined;
  const results = parts.filter((p) => p.type === "tool_result");
  const others = parts.filter((p) => p.type !== "tool_result");
  ctx.warnings.push({
    code: "tool_result_reordered",
    message: "Moved tool_result blocks ahead of text in an Anthropic user turn",
    fidelity: "COMPATIBLE",
    field: "messages.user.content",
  });
  return [...results, ...others];
}
