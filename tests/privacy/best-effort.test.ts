/**
 * `strict` vs `best_effort` runtime modes (PR-024, INV-5/INV-18).
 * Covers PT-10/71.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import type {
  PrivacyCompletionReport,
  PrivacyRecognizer,
} from "../../src/index.js";

function throwingRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize() {
      throw new Error("recognizer exploded");
    },
  };
}

function invalidRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize() {
      return [{ start: 0, end: 5, type: "x", value: "WRONG" }];
    },
  };
}

function fetchOk(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function openaiRequest(): Request {
  return new Request("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello world" }],
    }),
  });
}

describe("privacy runtime modes", () => {
  it("rejects a recognizer failure in strict mode (PT-10)", async () => {
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchOk(),
      privacy: { recognizers: [throwingRecognizer()] },
    });
    await expect(forward(openaiRequest())).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_recognizer_failed",
    });
  });

  it("degrades with a warning in best_effort mode (PT-10/71)", async () => {
    let report: PrivacyCompletionReport | undefined;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchOk(),
      privacy: {
        recognizers: [throwingRecognizer()],
        securityMode: "best_effort",
        recognition: { onRecognizerError: "passthrough_with_warning" },
      },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    await expect(forward(openaiRequest())).resolves.toBeDefined();
    expect(report?.degraded).toBe(true);
    expect(report?.securityMode).toBe("best_effort");
    expect(report?.warnings.some((w) => w.code === "privacy_recognizer_failed")).toBe(true);
  });

  it("drops invalid detections with a warning in best_effort mode", async () => {
    let report: PrivacyCompletionReport | undefined;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchOk(),
      privacy: {
        recognizers: [invalidRecognizer()],
        securityMode: "best_effort",
        recognition: { onInvalidDetection: "drop_with_warning" },
      },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    await expect(forward(openaiRequest())).resolves.toBeDefined();
    expect(report?.invalidDetections).toBe(1);
    expect(report?.degraded).toBe(true);
  });

  it("ignores configured downgrades in strict mode and warns (PT-71)", async () => {
    let report: PrivacyCompletionReport | undefined;
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: fetchOk(),
      privacy: {
        recognizers: [{ priority: 1, recognize: () => [] }],
        securityMode: "strict",
        recognition: { onRecognizerError: "passthrough_with_warning" },
      },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    await expect(forward(openaiRequest())).resolves.toBeDefined();
    expect(report?.securityMode).toBe("strict");
    expect(report?.warnings.some((w) => w.code === "privacy_degraded_mode")).toBe(true);
  });
});
