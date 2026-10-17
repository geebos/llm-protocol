/**
 * IR expansion contract tests (docs/07 §5.3/§5.4, plan step 1).
 *
 * Compile-time coverage of the multi-choice response and the expanded
 * ContentPart variants; runtime assertions only pin the shape.
 */
import { describe, expect, it } from "vitest";
import type { CanonicalResponse, ContentPart } from "../../src/index.js";

describe("CanonicalResponse choices (step 1)", () => {
  it("models multiple choices with per-choice finish reason", () => {
    const response: CanonicalResponse = {
      id: "r1",
      model: "m",
      choices: [
        { index: 0, content: [{ type: "text", text: "a" }], finishReason: "end_turn" },
        { index: 1, content: [{ type: "text", text: "b" }] },
      ],
    };
    expect(response.choices).toHaveLength(2);
    expect(response.choices.map((c) => c.index)).toEqual([0, 1]);
    expect(response.choices[0].finishReason).toBe("end_turn");
  });

  it("allows a choice-scoped native partition", () => {
    const response: CanonicalResponse = {
      choices: [
        {
          index: 0,
          content: [{ type: "text", text: "ok" }],
          native: { chat: { extra: { logprobs: null } } },
        },
      ],
    };
    expect(response.choices[0].native?.chat).toBeDefined();
  });
});

describe("expanded ContentPart variants (step 1)", () => {
  it("covers file / refusal / annotation / opaque_native", () => {
    const parts = [
      { type: "file", source: { type: "url", url: "https://x/y.pdf" }, filename: "y.pdf" },
      { type: "refusal", text: "I cannot help with that" },
      {
        type: "annotation",
        kind: "url_citation",
        text: "src",
        startIndex: 0,
        endIndex: 3,
        url: "https://x",
      },
      {
        type: "opaque_native",
        sourceFormat: "anthropic-messages",
        raw: { type: "server_tool_use" },
      },
    ] satisfies ContentPart[];
    expect(parts.map((p) => p.type)).toEqual([
      "file",
      "refusal",
      "annotation",
      "opaque_native",
    ]);
  });
});
