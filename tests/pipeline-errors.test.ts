/**
 * Pipeline edge-case and error-branch tests (FR-011, TC-023).
 *
 * Covers upstream fetch failures, cancellation, non-JSON bodies, the
 * not-yet-implemented openai-responses adapter, and error codec fallbacks.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { TranslationError } from "../src/errors.js";
import { getAdapter } from "../src/codecs/registry.js";

function openaiChatRequest(url = "https://api.anthropic.com/v1/chat/completions"): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer key" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("translate: upstream failures", () => {
  it("wraps a throwing fetch as an upstream error", async () => {
    const fetch = (async () => {
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const err = await forward(openaiChatRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("upstream");
  });

  it("wraps a fetch failure as cancelled when the caller aborts", async () => {
    const fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const controller = new AbortController();
    controller.abort();
    const request = openaiChatRequest();
    // attach a fresh signal so the handler sees an aborted signal
    const req = new Request(request, { signal: controller.signal });
    const err = await forward(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("cancelled");
  });

  it("rejects a non-JSON upstream body with an upstream error", async () => {
    const fetch = (async () =>
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const err = await forward(openaiChatRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect((err as TranslationError).kind).toBe("upstream");
  });
});

describe("translate: openai-responses is P1 scope", () => {
  it("rejects selecting the not-yet-implemented adapter", () => {
    expect(() => getAdapter("openai-responses")).toThrow(/P1/);
  });
});

describe("error codec fallbacks", () => {
  it("Anthropic error codec falls back on missing fields", () => {
    const adapter = getAdapter("anthropic-messages");
    const err = adapter.error.parseError({ error: { type: "authentication_error" } }, 401);
    expect(err.kind).toBe("upstream");
    expect(err.message).toContain("upstream error");
    expect(err.status).toBe(401);
  });

  it("OpenAI error codec derives kind from status", () => {
    const adapter = getAdapter("openai-chat");
    const err = adapter.error.parseError({ error: { message: "too many" } }, 429);
    expect(err.kind).toBe("rate_limit");
  });

  it("Anthropic error codec maps rate_limit_error", () => {
    const adapter = getAdapter("anthropic-messages");
    const err = adapter.error.parseError(
      { error: { type: "rate_limit_error", message: "slow down", request_id: "r1" } },
      429,
    );
    expect(err.kind).toBe("rate_limit");
    expect(err.requestId).toBe("r1");
  });
});
