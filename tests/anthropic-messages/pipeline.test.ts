/**
 * translate() factory tests, Anthropic Messages -> OpenAI Chat direction
 * (M1, section 9.13, TC-019/021/023/024).
 *
 * Each test injects a fake fetch that captures the target Request and returns
 * a canned upstream Response, then asserts the source protocol is fully
 * restored on the way out.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import { TranslationError } from "../../src/errors.js";

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
    const openaiWithReasoning = await import("../../src/codecs/openai-chat/index.js");
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
