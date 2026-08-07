/**
 * Prompt-cache affinity tests (Messages -> Chat, cache_control ->
 * prompt_cache_key). Covers the P0 matrix: anchor extraction, deterministic
 * key, capability-gated injection, resolver priority, and the transparent
 * translate() integration with the golden fixture.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import {
  deriveAnthropicCacheKey,
  extractAnthropicCacheAnchors,
  anthropicCacheControlResolver,
} from "../src/cache/anthropic/cache-control.js";
import {
  composeCacheResolvers,
  explicitCacheKeyResolver,
  resolveCacheAffinity,
} from "../src/cache/resolver.js";
import { applyOpenAIChatCacheAffinity } from "../src/cache/openai-chat/apply-cache-affinity.js";
import type { ProviderProfile } from "../src/capabilities/provider-profile.js";
import type { CacheAffinityResolver } from "../src/cache/resolver.js";
import { newCodecContext } from "../src/codecs/protocol-adapter.js";

const openaiTextResponse = {
  id: "chatcmpl_456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): {
  fetch: typeof fetch;
  lastRequest: () => CapturedRequest;
} {
  let captured: CapturedRequest | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = { url: req.url, headers: new Headers(req.headers), body: await req.json() };
    return handler(req);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    lastRequest: () => {
      if (!captured) throw new Error("fetch was never called");
      return captured;
    },
  };
}

/** Minimal provider profile for capability-gated unit tests. */
function chatProfile(promptCacheKey: boolean): ProviderProfile {
  return {
    protocol: "openai-chat",
    capabilities: {
      tools: true,
      parallelTools: true,
      streaming: true,
      thinking: false,
      cache: { promptCacheKey },
    },
    defaultHeaders: {},
  };
}

describe("extractAnthropicCacheAnchors: anchor filter and seed order", () => {
  it("collects system + first user anchor in Sub2API seed order", () => {
    const body = {
      model: "m",
      system: [
        { type: "text", text: "project instructions", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "repository context", cache_control: { type: "ephemeral" } },
            { type: "text", text: "dynamic question" },
          ],
        },
      ],
    };
    const anchors = extractAnthropicCacheAnchors(body);
    expect(anchors.map((a) => `${a.location}:${a.text}`)).toEqual([
      "system:project instructions",
      "user:repository context",
    ]);
  });

  it("places the first user anchor last, after all assistant anchors", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const anchors = extractAnthropicCacheAnchors(body);
    // assistant anchor precedes the first user anchor regardless of turn order.
    expect(anchors.map((a) => `${a.location}:${a.text}`)).toEqual([
      "assistant:stable prefix",
      "user:repo",
    ]);
  });

  it("ignores later user cache anchors (first cached user block only)", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const anchors = extractAnthropicCacheAnchors(body);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe("repo");
  });

  it("ignores non-text, empty-text, invalid and non-ephemeral cache blocks", () => {
    const body = {
      model: "m",
      system: [
        { type: "text", text: "", cache_control: { type: "ephemeral" } },
        { type: "text", text: "   ", cache_control: { type: "ephemeral" } },
        { type: "text", text: "no cache" },
        { type: "text", text: "wrong type", cache_control: { type: "persistent" } },
        { type: "text", text: "bad cc", cache_control: { type: "ephemeral", ttl: 42 } },
        { type: "image", source: { type: "url", url: "https://x/y.png" }, cache_control: { type: "ephemeral" } },
        { type: "tool_use", id: "t1", name: "f", input: {}, cache_control: { type: "ephemeral" } },
        { type: "thinking", thinking: "thought", cache_control: { type: "ephemeral" } },
        { type: "document", title: "d", content: "x", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "repo", cache_control: { type: "ephemeral" } },
            { type: "text", text: "  keep me  ", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
    };
    const anchors = extractAnthropicCacheAnchors(body);
    // Only the first cached user block anchors; the later "keep me" block
    // (same turn) is deliberately excluded, exactly like a later user turn.
    expect(anchors).toEqual([
      { location: "user", text: "repo", cacheControl: { type: "ephemeral" }, messageIndex: 0, contentIndex: 0 },
    ]);
  });
});

describe("deriveAnthropicCacheKey: deterministic identity", () => {
  const KEY_RE = /^anthropic-cache-[0-9a-f]{32}$/;

  it("is deterministic with the expected prefix and a fixed vector", () => {
    const key = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({
        model: "m",
        system: [{ type: "text", text: "project instructions", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "repository context", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    );
    expect(key).toBe("anthropic-cache-f1a6c616742c039a29db85132d256f4a");
  });

  it("returns undefined when there are no anchors", () => {
    expect(deriveAnthropicCacheKey([])).toBeUndefined();
    expect(
      deriveAnthropicCacheKey(extractAnthropicCacheAnchors({ model: "m", messages: [] })),
    ).toBeUndefined();
  });

  it("returns 32-hex keys", () => {
    const key = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }],
      }),
    );
    expect(key).toMatch(KEY_RE);
  });

  it("keeps the key stable when normal turns are appended (regression invariant)", () => {
    const turn1 = {
      model: "m",
      system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const turn10 = {
      ...turn1,
      messages: [
        ...turn1.messages,
        { role: "assistant", content: [{ type: "text", text: "answer 1" }] },
        { role: "user", content: [{ type: "text", text: "question 2" }] },
        { role: "assistant", content: [{ type: "text", text: "answer 2" }] },
      ],
    };
    expect(deriveAnthropicCacheKey(extractAnthropicCacheAnchors(turn1))).toBe(
      deriveAnthropicCacheKey(extractAnthropicCacheAnchors(turn10)),
    );
  });

  it("changes the key when a cached system or first cached user text changes", () => {
    const base = {
      model: "m",
      system: [{ type: "text", text: "instructions v1", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const baseKey = deriveAnthropicCacheKey(extractAnthropicCacheAnchors(base));
    const sysV2 = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({ ...base, system: [{ type: "text", text: "instructions v2", cache_control: { type: "ephemeral" } }] }),
    );
    const userV2 = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({
        ...base,
        messages: [{ role: "user", content: [{ type: "text", text: "different repo", cache_control: { type: "ephemeral" } }] }],
      }),
    );
    expect(sysV2).not.toBe(baseKey);
    expect(userV2).not.toBe(baseKey);
  });

  it("does not change the key when a non-cached message changes", () => {
    const a = extractAnthropicCacheAnchors({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "original answer" }] },
      ],
    });
    const b = extractAnthropicCacheAnchors({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "edited answer" }] },
      ],
    });
    expect(deriveAnthropicCacheKey(a)).toBe(deriveAnthropicCacheKey(b));
  });

  it("treats anchor order as significant (system:A+B vs B+A differ)", () => {
    const ab = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({
        model: "m",
        system: [
          { type: "text", text: "A", cache_control: { type: "ephemeral" } },
          { type: "text", text: "B", cache_control: { type: "ephemeral" } },
        ],
      }),
    );
    const ba = deriveAnthropicCacheKey(
      extractAnthropicCacheAnchors({
        model: "m",
        system: [
          { type: "text", text: "B", cache_control: { type: "ephemeral" } },
          { type: "text", text: "A", cache_control: { type: "ephemeral" } },
        ],
      }),
    );
    expect(ab).not.toBe(ba);
  });

  it("ignores stream/non-stream and ttl when deriving the key", () => {
    const withStreamTrue = {
      model: "m",
      stream: true,
      system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] }],
    };
    const withStreamFalseTtl = {
      model: "m",
      stream: false,
      system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] }],
    };
    expect(deriveAnthropicCacheKey(extractAnthropicCacheAnchors(withStreamTrue))).toBe(
      deriveAnthropicCacheKey(extractAnthropicCacheAnchors(withStreamFalseTtl)),
    );
  });
});

describe("resolver chain: priority and composition", () => {
  const canonical = {} as never;

  it("lets the first resolver with a key win (explicit > anchors)", async () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] }],
    };
    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-llm-prompt-cache-key": "explicit-key" },
    });
    const affinity = await resolveCacheAffinity(
      [explicitCacheKeyResolver(), anthropicCacheControlResolver()],
      request,
      body,
      canonical,
    );
    expect(affinity).toMatchObject({ key: "explicit-key", source: "explicit" });
  });

  it("falls through to the anchor resolver when no explicit key is present", async () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "repo", cache_control: { type: "ephemeral" } }] }],
    };
    const request = new Request("https://api.openai.com/v1/messages", { method: "POST" });
    const affinity = await resolveCacheAffinity(
      [explicitCacheKeyResolver(), anthropicCacheControlResolver()],
      request,
      body,
      canonical,
    );
    expect(affinity?.source).toBe("anthropic-cache-control");
    expect(affinity?.key).toMatch(/^anthropic-cache-/);
  });

  it("returns undefined when no resolver yields a key", async () => {
    const affinity = await resolveCacheAffinity(
      [explicitCacheKeyResolver(), anthropicCacheControlResolver()],
      new Request("https://api.openai.com/v1/messages", { method: "POST" }),
      { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "no cache" }] }] },
      canonical,
    );
    expect(affinity).toBeUndefined();
  });

  it("composeCacheResolvers preserves first-wins semantics", async () => {
    const only: CacheAffinityResolver = {
      async resolve() {
        return { key: "only-key", source: "explicit" };
      },
    };
    const composed = composeCacheResolvers([only]);
    const affinity = await composed.resolve(
      new Request("https://api.openai.com/v1/messages", { method: "POST" }),
      {},
      canonical,
    );
    expect(affinity?.key).toBe("only-key");
  });
});

describe("applyOpenAIChatCacheAffinity: capability-gated injection", () => {
  it("injects prompt_cache_key when the profile supports it (approximation flagged)", () => {
    const ctx = newCodecContext();
    const affinity = {
      key: "anthropic-cache-abc",
      source: "anthropic-cache-control" as const,
      anchors: [],
      lossy: true,
    };
    const { body, report } = applyOpenAIChatCacheAffinity(
      { model: "m", messages: [] },
      affinity,
      chatProfile(true),
      ctx,
    );
    expect(body).toMatchObject({ model: "m", messages: [], prompt_cache_key: "anthropic-cache-abc" });
    expect(report).toMatchObject({
      detected: true,
      source: "anthropic-cache-control",
      targetKeyInjected: true,
      degraded: true,
    });
    expect(ctx.warnings.map((w) => w.code)).toContain("cache_control_downgraded_to_cache_key");
  });

  it("does not inject and warns when the target does not declare support", () => {
    const ctx = newCodecContext();
    const affinity = { key: "k", source: "anthropic-cache-control" as const, lossy: true };
    const { body, report } = applyOpenAIChatCacheAffinity(
      { model: "m", messages: [] },
      affinity,
      chatProfile(false),
      ctx,
    );
    expect(body).toEqual({ model: "m", messages: [] });
    expect(report).toMatchObject({ targetKeyInjected: false, degraded: true });
    expect(ctx.warnings.map((w) => w.code)).toContain("cache_target_unsupported");
  });

  it("never overrides an explicitly present prompt_cache_key on the body", () => {
    const ctx = newCodecContext();
    const affinity = { key: "generated", source: "anthropic-cache-control" as const, lossy: true };
    const { body, report } = applyOpenAIChatCacheAffinity(
      { model: "m", messages: [], prompt_cache_key: "explicit-existing" },
      affinity,
      chatProfile(true),
      ctx,
    );
    expect(body).toMatchObject({ prompt_cache_key: "explicit-existing" });
    expect(report.targetKeyInjected).toBe(false);
    expect(report.degraded).toBe(false);
    expect(ctx.warnings).toHaveLength(0);
  });

  it("reports unrepresentable TTL but still injects the same key", () => {
    const ctx = newCodecContext();
    const affinity = {
      key: "k",
      source: "anthropic-cache-control" as const,
      anchors: [{ location: "system" as const, text: "x", cacheControl: { type: "ephemeral" as const, ttl: "1h" } }],
      lossy: true,
    };
    const { body, report } = applyOpenAIChatCacheAffinity(
      { model: "m", messages: [] },
      affinity,
      chatProfile(true),
      ctx,
    );
    expect(body).toMatchObject({ prompt_cache_key: "k" });
    expect(ctx.warnings.map((w) => w.code)).toContain("cache_ttl_not_representable");
    expect(report.warnings.some((w) => w.code === "cache_ttl_not_representable")).toBe(true);
  });

  it("leaves the body untouched when there is no affinity", () => {
    const ctx = newCodecContext();
    const { body, report } = applyOpenAIChatCacheAffinity(
      { model: "m", messages: [] },
      undefined,
      chatProfile(true),
      ctx,
    );
    expect(body).toEqual({ model: "m", messages: [] });
    expect(report.detected).toBe(false);
    expect(ctx.warnings).toHaveLength(0);
  });
});

describe("translate() integration: Messages -> Chat prompt cache", () => {
  const goldenRequest = {
    model: "claude-sonnet",
    max_tokens: 100,
    system: [
      { type: "text", text: "project instructions", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "repository context", cache_control: { type: "ephemeral" } },
          { type: "text", text: "dynamic question" },
        ],
      },
    ],
  };

  it("injects a stable prompt_cache_key from source cache_control anchors (golden)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
    });
    const response = await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(response.status).toBe(200);
    const captured = lastRequest();
    expect(captured.body).toMatchObject({
      model: "claude-sonnet",
      stream: false,
      messages: [
        { role: "system", content: "project instructions" },
        { role: "user", content: expect.any(String) },
      ],
    });
    expect(captured.body.prompt_cache_key).toBe(
      "anthropic-cache-f1a6c616742c039a29db85132d256f4a",
    );
  });

  it("reports the cache summary and warning in the trace", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    const report = traces[0].cache as Record<string, unknown>;
    expect(report).toMatchObject({
      detected: true,
      source: "anthropic-cache-control",
      targetKeyInjected: true,
      anchorCount: 2,
      degraded: true,
    });
    expect(traces[0].warnings).toContainEqual(
      expect.objectContaining({ code: "cache_control_downgraded_to_cache_key" }),
    );
  });

  it("injects nothing when the source has no cache_control", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
    expect((traces[0].cache as Record<string, unknown>).detected).toBe(false);
    expect(traces[0].warnings).not.toContainEqual(
      expect.objectContaining({ code: "cache_control_downgraded_to_cache_key" }),
    );
  });

  it("is fully opt-in: default translate() never adds prompt_cache_key", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
  });

  it("does not inject when the target profile does not declare prompt_cache_key", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      profiles: { "openai-chat": chatProfile(false) },
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "key", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBeUndefined();
    expect((traces[0].cache as Record<string, unknown>).targetKeyInjected).toBe(false);
    expect(traces[0].warnings).toContainEqual(
      expect.objectContaining({ code: "cache_target_unsupported" }),
    );
  });

  it("honors an explicit x-llm-prompt-cache-key header over anchors and does not leak it upstream", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch, cache: {} });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": "key",
          "content-type": "application/json",
          "x-llm-prompt-cache-key": "explicit-session-key",
        },
        body: JSON.stringify(goldenRequest),
      }),
    );
    expect(lastRequest().body.prompt_cache_key).toBe("explicit-session-key");
    expect(lastRequest().headers.get("x-llm-prompt-cache-key")).toBeNull();
  });

  it("traces never leak the cache key, anchor text or prompt content", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "anthropic-messages",
      to: "openai-chat",
      fetch,
      cache: {},
      trace: (t) => traces.push({ ...t }),
    });
    await forward(
      new Request("https://api.openai.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "TOP_SECRET_KEY", "content-type": "application/json" },
        body: JSON.stringify(goldenRequest),
      }),
    );
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("f1a6c616742c039a29db85132d256f4a");
    expect(serialized).not.toContain("project instructions");
    expect(serialized).not.toContain("repository context");
    expect(serialized).not.toContain("TOP_SECRET_KEY");
  });
});
