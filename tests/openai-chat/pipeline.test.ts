/**
 * translate entry tests, OpenAI Chat -> Anthropic Messages direction
 * (M1, section 9.13, TC-019/021/023/024).
 *
 * Each test injects a fake fetch that captures the target Request and returns
 * a canned upstream Response, then asserts the source protocol is fully
 * restored on the way out.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";

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
  it("uses the url/headers verbatim and converts the body (TC-019)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicTextResponse));

    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": "sk-ant-secret",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }],
      },
      fetch,
    });
    const captured = lastRequest();

    // 9.1/9.2: URL and headers are final and used verbatim (no path rewrite or
    // credential move); the caller supplies the target-shaped headers.
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured.headers.get("x-api-key")).toBe("sk-ant-secret");
    expect(captured.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(captured.headers.get("authorization")).toBeNull();
    expect(captured.headers.get("content-type")).toBe("application/json");

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

    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "key" },
      body: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Weather in Paris?" }],
      },
      fetch,
    });
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
    const response = await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "key" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    // OpenAI error envelope: { error: {...} } with no top-level type field
    expect((body.error as Record<string, unknown>).type).toBe("invalid_request_error");
    expect((body.error as Record<string, unknown>).message).toContain("Incorrect API key");
  });
});

describe("translate: credential isolation (TC-021)", () => {
  it("keeps per-request credentials isolated across calls (TC-021)", async () => {
    const captured: string[] = [];
    const { fetch } = fakeFetch(async (req) => {
      captured.push(req.headers.get("x-api-key") ?? "");
      return jsonResponse(anthropicTextResponse);
    });

    const call = (key: string) =>
      translate.chat.messages({
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": key },
        body: { model: "m", messages: [{ role: "user", content: "hi" }] },
        fetch,
      });

    await call("key-a");
    await call("key-b");
    expect(captured).toEqual(["key-a", "key-b"]);
  });
});

describe("translate: traces never contain credentials", () => {
  it("reports fidelity warnings without leaking the key", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "TOP_SECRET_KEY" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("TOP_SECRET_KEY");
    expect(serialized).not.toContain("hi");
  });

  it("carries traceId, durationMs and worst-fidelity summary (NFR-005)", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "k" },
      body: {
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    const t = traces[0];
    expect(typeof t.traceId).toBe("string");
    expect((t.traceId as string).length).toBeGreaterThan(8);
    expect(typeof t.durationMs).toBe("number");
    expect(t.fidelity).toBe("EXACT");
  });

  it("summarizes worst fidelity as COMPATIBLE when a warning exists", async () => {
    const traces: Array<Record<string, unknown>> = [];
    const { fetch } = fakeFetch(() => jsonResponse(anthropicTextResponse));
    // anthropic target default max_tokens => COMPATIBLE warning (not LOSSY).
    await translate.chat.messages({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "k" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      fetch,
      trace: (t) => traces.push({ ...t }),
    });
    expect(traces[0].fidelity).toBe("COMPATIBLE");
  });
});
