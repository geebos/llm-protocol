/**
 * Privacy-safe cache affinity (PR-021/PR-025). Covers PT-57/58/70.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import {
  deriveAnthropicCacheKey,
  explicitCacheKeyResolver,
  type PrivacyRecognizer,
  type PrivacyWarning,
} from "../../src/index.js";

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      for (const value of ["13800138000", "13900139000"]) {
        let idx = text.indexOf(value);
        while (idx !== -1) {
          out.push({ start: idx, end: idx + 11, type: "phone" });
          idx = text.indexOf(value, idx + 1);
        }
      }
      return out;
    },
  };
}

interface Capture {
  fetch: typeof fetch;
  lastBody: () => Record<string, unknown>;
}

function capturingFetch(): Capture {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    body = (await req.json()) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, lastBody: () => body };
}

function anthropicRequest(phone: string, headers: Record<string, string> = {}): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk", "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      system: [
        { type: "text", text: `owner ${phone}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

const tenantKey = () => new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);

describe("privacy-safe cache affinity", () => {
  it("derives a stable key from the redacted anchors (PT-57)", async () => {
    const keyFor = async (phone: string): Promise<string | undefined> => {
      const cap = capturingFetch();
      const forward = translate({
        from: "anthropic-messages",
        to: "openai-chat",
        fetch: cap.fetch,
        cache: { key: tenantKey, namespace: "tenant-1" },
        privacy: { recognizers: [phoneRecognizer()] },
      });
      await forward(anthropicRequest(phone));
      return cap.lastBody().prompt_cache_key as string | undefined;
    };
    const a = await keyFor("13800138000");
    const b = await keyFor("13900139000");
    expect(a).toBeDefined();
    expect(a).toMatch(/^anthropic-cache-[0-9a-f]{32}$/);
    // Different raw values, identical redacted anchor => identical key.
    expect(a).toBe(b);
  });

  it("does not expose an enumerable hash of the raw anchor (PT-58)", async () => {
    const cap = capturingFetch();
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch: cap.fetch,
      cache: { key: tenantKey, namespace: "tenant-1" },
      privacy: { recognizers: [phoneRecognizer()] },
    });
    await forward(anthropicRequest("13800138000"));
    const key = cap.lastBody().prompt_cache_key as string;
    // The legacy SHA-256 identity over the same anchor differs from the HMAC.
    const legacy = deriveAnthropicCacheKey([
      { location: "system", text: "owner 13800138000", cacheControl: { type: "ephemeral" } },
    ]);
    expect(key).not.toBe(legacy);
  });

  it("blocks legacy request-reading resolvers under privacy (PT-70)", async () => {
    const cap = capturingFetch();
    const warnings: PrivacyWarning[] = [];
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch: cap.fetch,
      cache: { resolvers: [explicitCacheKeyResolver()] },
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (report) => {
        warnings.push(...report.warnings);
      },
    });
    await forward(anthropicRequest("13800138000", { "x-llm-prompt-cache-key": "tenant-key" }));
    expect(cap.lastBody().prompt_cache_key).toBeUndefined();
    expect(warnings.some((w) => w.code === "privacy_untrusted_cache_resolver")).toBe(true);
  });

  it("allows legacy resolvers when explicitly authorized (PT-70)", async () => {
    const cap = capturingFetch();
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch: cap.fetch,
      cache: { resolvers: [explicitCacheKeyResolver()] },
      privacy: { recognizers: [phoneRecognizer()], allowLegacyCacheResolvers: true },
    });
    await forward(anthropicRequest("13800138000", { "x-llm-prompt-cache-key": "tenant-key" }));
    expect(cap.lastBody().prompt_cache_key).toBe("tenant-key");
  });
});
