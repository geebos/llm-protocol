/**
 * translate() factory tests (M1, section 9.13, TC-019/021/023/024).
 *
 * Each test injects a fake fetch that captures the target Request and returns
 * a canned upstream Response, then asserts the source protocol is fully
 * restored on the way out.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/pipeline/translate.js";
import { TranslationError } from "../src/errors.js";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null;
}

function fakeFetch(
  handler: (req: Request) => Response | Promise<Response>,
): { fetch: typeof fetch; lastRequest: () => CapturedRequest } {
  let captured: CapturedRequest | undefined;
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req =
      input instanceof Request ? input : new Request(input as RequestInfo, init);
    captured = {
      url: req.url,
      headers: new Headers(req.headers),
      body: await req.json(),
      signal: req.signal ?? null,
    };
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

const anthropicTextResponse = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
};

const openaiTextResponse = {
  id: "chatcmpl_456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from GPT" },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("translate: OpenAI Chat -> Anthropic Messages", () => {
  it("rewrites URL path, headers and body to the target protocol (TC-019, 9.13#1)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-secret",
        "content-type": "application/json",
        "x-tracing": "should-be-stripped",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    const response = await forward(request);
    const captured = lastRequest();

    // 9.13#2: origin preserved, pathname converted
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");

    // 9.13#3: credential value moved to x-api-key
    expect(captured.headers.get("x-api-key")).toBe("sk-ant-secret");
    expect(captured.headers.get("anthropic-version")).toBe("2023-06-01");
    // 9.13#5: no source auth header leaked, hop-by-hop stripped
    expect(captured.headers.get("authorization")).toBeNull();
    expect(captured.headers.get("x-tracing")).toBeNull();
    expect(captured.headers.get("content-length")).toBeNull();

    // 9.13#7: body converted
    expect(captured.body).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    });

    // 9.13#8: response restored to from protocol
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "claude-sonnet-4-5",
    });
    const choice = (body.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message).toMatchObject({
      role: "assistant",
      content: "Hello from Claude",
    });
    const usage = body.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(8);
    expect(usage.completion_tokens).toBe(4);
  });

  it("converts a tool call response into OpenAI tool_calls (TC-004)", async () => {
    const anthropicToolResponse = {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "I will check the weather." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    const { fetch } = fakeFetch(() => jsonResponse(anthropicToolResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }),
    });

    const response = await forward(request);
    const body = (await response.json()) as Record<string, unknown>;
    const message = ((body.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
    expect(message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect((body.choices as Array<Record<string, unknown>>)[0].finish_reason).toBe("tool_calls");
  });

  it("propagates a request body twice without reuse (FR-004 validation)", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await forward(request);
    await expect(forward(request)).rejects.toThrow(/consumed/);
  });

  it("rejects a mismatched source pathname with a typed validation error", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    await expect(forward(request)).rejects.toThrow(/does not match/);
  });
});

describe("translate: Anthropic Messages -> OpenAI Chat", () => {
  it("converts URL path, headers and body (TC-019, 9.13#2/4)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });

    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-openai-secret",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 512,
        system: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const response = await forward(request);
    const captured = lastRequest();

    expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
    // 9.13#4: x-api-key value -> Authorization Bearer
    expect(captured.headers.get("authorization")).toBe("Bearer sk-openai-secret");
    // 9.13#5: no source credential leak
    expect(captured.headers.get("x-api-key")).toBeNull();
    expect(captured.headers.get("anthropic-version")).toBeNull();

    expect(captured.body).toMatchObject({
      model: "gpt-4o",
      stream: false,
      max_tokens: 512,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });

    // response restored to Anthropic protocol
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([{ type: "text", text: "Hello from GPT" }]);
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(8);
  });

  it("reverse-translates an upstream error into Anthropic error shape (TC-023)", async () => {
    const upstreamError = {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "You are being rate limited",
        request_id: "req_abc",
      },
    };
    const { fetch } = fakeFetch(() =>
      new Response(JSON.stringify(upstreamError), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });
    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const response = await forward(request);
    expect(response.status).toBe(429);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("error");
    expect((body.error as Record<string, unknown>).type).toBe("rate_limit_error");
    expect((body.error as Record<string, unknown>).request_id).toBe("req_abc");
  });

  it("converts Anthropic thinking blocks into provider reasoning field when declared", async () => {
    const profile = {
      protocol: "openai-chat" as const,
      capabilities: {
        tools: true,
        parallelTools: true,
        streaming: true,
        thinking: true,
        reasoningField: "reasoning_content",
      },
      defaultHeaders: {},
    };
    const openaiWithReasoning = await import("../src/codecs/openai-chat/index.js");
    const adapter = openaiWithReasoning.createOpenAiChatAdapter(profile);
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({ from: "anthropic-messages", to: "openai-chat", fetch });

    const request = new Request("https://api.openai.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "chain", signature: "sig-1" },
              { type: "text", text: "Answer" },
            ],
          },
        ],
      }),
    });
    await forward(request);
  });
});

describe("translate: upstream error and status handling", () => {
  it("reverse-translates OpenAI upstream error into Anthropic error shape", async () => {
    const upstreamError = {
      error: {
        message: "Incorrect API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    };
    const { fetch } = fakeFetch(() =>
      new Response(JSON.stringify(upstreamError), { status: 401 }),
    );
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer key" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await forward(request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    // OpenAI error envelope: { error: {...} } with no top-level type field
    expect((body.error as Record<string, unknown>).type).toBe("invalid_request_error");
    expect((body.error as Record<string, unknown>).message).toContain("Incorrect API key");
  });
});

describe("translate: same-protocol passthrough (TC-024, FR-006)", () => {
  it("does not parse or rewrite the body, and preserves URL/headers", async () => {
    const rawBody = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const { fetch, lastRequest } = fakeFetch((req) => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const forward = translate({ from: "openai-chat", to: "openai-chat", fetch });
    const request = new Request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: rawBody,
    });
    const response = await forward(request);
    const captured = lastRequest();
    expect(captured.url).toBe("https://api.example.com/v1/chat/completions");
    expect(captured.headers.get("authorization")).toBe("Bearer k");
    expect(JSON.stringify(captured.body)).toBe(JSON.stringify(JSON.parse(rawBody)));
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("translate: factory reuse and credential isolation (TC-021)", () => {
  it("keeps per-request credentials isolated across calls", async () => {
    const captured: string[] = [];
    const { fetch } = fakeFetch(async (req) => {
      captured.push(req.headers.get("x-api-key") ?? "");
      return jsonResponse(anthropicTextResponse);
    });
    const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });

    const mk = (key: string) =>
      new Request("https://api.anthropic.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });

    await forward(mk("key-a"));
    await forward(mk("key-b"));
    expect(captured).toEqual(["key-a", "key-b"]);
  });
});

describe("translate: traces never contain credentials", () => {
  it("reports fidelity warnings without leaking the key", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer TOP_SECRET_KEY" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await forward(request);
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("TOP_SECRET_KEY");
    expect(serialized).not.toContain("hi");
  });

  it("carries traceId, durationMs and worst-fidelity summary (NFR-005)", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await forward(request);
    const t = traces[0];
    expect(typeof t.traceId).toBe("string");
    expect((t.traceId as string).length).toBeGreaterThan(8);
    expect(typeof t.durationMs).toBe("number");
    expect(t.fidelity).toBe("EXACT");
  });

  it("summarizes worst fidelity as LOSSY when a warning exists", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    // anthropic target default max_tokens => COMPATIBLE warning (not LOSSY).
    const request = new Request("https://api.anthropic.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await forward(request);
    expect(traces[0].fidelity).toBe("COMPATIBLE");
  });
});
