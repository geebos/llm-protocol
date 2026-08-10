/**
 * translate() factory tests with no source-protocol direction:
 * same-protocol passthrough (TC-024, FR-006). Direction-specific pipeline
 * tests live under tests/<source-protocol>/.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
