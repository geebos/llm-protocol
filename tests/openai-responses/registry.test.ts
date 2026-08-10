/**
 * Responses tool registries tests (responses.md §10.4).
 *
 * Tool Definition Registry (by normalized name, collision rejection) and
 * Tool Call Registry (byCallId/byItemId double index, duplicate rejection),
 * plus Responses-side order-preserving normalization.
 */
import { describe, expect, it } from "vitest";
import { newCodecContext } from "../../src/codecs/protocol-adapter.js";
import type { CodecContext } from "../../src/codecs/protocol-adapter.js";
import {
  registerToolCall,
  registerToolDefinition,
  resolveCallByItemId,
  resolveDefinition,
  normalizeForResponses,
} from "../../src/codecs/openai-responses/normalize.js";

function ctx(): CodecContext {
  return newCodecContext();
}

{
  it("double-indexes call entries by call_id and item_id", () => {
    const c = ctx();
    registerToolCall(c, "call_1", {
      normalizedToolName: "a",
      originalName: "a",
      executionKind: "function",
      sourceItemId: "item_src",
      targetItemId: "item_tgt",
    });
    expect(resolveCallByItemId(c, "item_src")?.normalizedToolName).toBe("a");
    expect(resolveCallByItemId(c, "item_tgt")?.normalizedToolName).toBe("a");
  });

  it("rejects duplicate call_ids (ambiguous route, §15.2)", () => {
    const c = ctx();
    registerToolCall(c, "call_1", {
      normalizedToolName: "a",
      originalName: "a",
      executionKind: "function",
    });
    expect(() =>
      registerToolCall(c, "call_1", {
        normalizedToolName: "b",
        originalName: "b",
        executionKind: "function",
      }),
    ).toThrow(/Duplicate call_id/);
  });

  it("registers definitions by normalized name and rejects flatten collisions", () => {
    const c = ctx();
    registerToolDefinition(c, {
      executionKind: "function",
      nameKind: "namespaced",
      originalName: "ns.child",
      namespace: "ns",
      normalizedName: "ns__child",
    });
    expect(resolveDefinition(c, "ns__child")?.namespace).toBe("ns");
    expect(() =>
      registerToolDefinition(c, {
        executionKind: "function",
        nameKind: "plain",
        originalName: "other",
        normalizedName: "ns__child",
      }),
    ).toThrow(/collision/);
  });

  it("normalizeForResponses merges adjacent same-role turns only", () => {
    const merged = normalizeForResponses([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toHaveLength(2);
  });
}
