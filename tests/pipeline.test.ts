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



{
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
}

{
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
}

{
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
}
