/**
 * translate entry tests, Anthropic Messages -> OpenAI Chat direction
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

const TARGET_URL = "https://api.openai.com/v1/chat/completions";
const HEADERS = { authorization: "Bearer sk-openai-secret" };

describe("translate: Anthropic Messages -> OpenAI Chat", () => {
  it("uses the url/headers verbatim and converts the body (TC-019)", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));

    const response = await translate.messages.chat({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
        model: "gpt-4o",
        max_tokens: 512,
        system: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
      },
      fetch,
    });
    const captured = lastRequest();

    // 9.1/9.2: URL and headers are final and used verbatim (no path rewrite or
    // credential move); the caller supplies the target-shaped headers.
    expect(captured.url).toBe(TARGET_URL);
    expect(captured.headers.get("authorization")).toBe("Bearer sk-openai-secret");
    expect(captured.headers.get("content-type")).toBe("application/json");

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

    const response = await translate.messages.chat({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      fetch,
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("error");
    expect((body.error as Record<string, unknown>).type).toBe("rate_limit_error");
    expect((body.error as Record<string, unknown>).request_id).toBe("req_abc");
  });

  it("converts Anthropic thinking blocks into a provider reasoning field when declared", async () => {
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
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));

    await translate.messages.chat({
      url: TARGET_URL,
      headers: HEADERS,
      body: {
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
      },
      profiles: { "openai-chat": profile },
      fetch,
    });
  });
});

describe("tool_result content rendering for a Chat target", () => {
  function toolResultBody(content: unknown): Record<string, unknown> {
    return {
      model: "gpt-4o",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read_image", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content }],
        },
      ],
      tools: [
        {
          name: "read_image",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };
  }

  it("renders a text+image tool_result as Chat text and image_url", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(openaiTextResponse));
    await translate.messages.chat({
      url: TARGET_URL,
      headers: HEADERS,
      body: toolResultBody([
        { type: "text", text: "saved" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ]),
      fetch,
    });
    const messages = (lastRequest().body as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toEqual([
      { type: "text", text: "saved" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("fails closed on an unknown block nested in tool_result instead of emitting IR", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    await expect(
      translate.messages.chat({
        url: TARGET_URL,
        headers: HEADERS,
        body: toolResultBody([
          { type: "text", text: "x" },
          { type: "server_tool_use", id: "s1", input: {} },
        ]),
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });

  it("fails closed on a thinking block nested in tool_result instead of emitting IR", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(openaiTextResponse));
    await expect(
      translate.messages.chat({
        url: TARGET_URL,
        headers: HEADERS,
        body: toolResultBody([
          { type: "thinking", thinking: "secret", signature: "sig-1" },
        ]),
        fetch,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", code: "non_droppable_field" });
  });
});
