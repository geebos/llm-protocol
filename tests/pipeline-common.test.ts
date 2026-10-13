/**
 * translate entry tests with no source-protocol direction: same-protocol calls
 * always go through the Canonical IR. Direction-specific pipeline tests live
 * under tests/<source-protocol>/.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/index.js";
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

describe("translate: same-protocol goes through the IR (TC-024)", () => {
  it("parses and re-renders the body/response, preserving URL and headers", async () => {
    const { fetch, lastRequest } = fakeFetch(() =>
      jsonResponse({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi back" }, finish_reason: "stop" },
        ],
      }),
    );
    const response = await translate.chat.chat({
      url: "https://api.example.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    const captured = lastRequest();
    // URL and headers are used verbatim.
    expect(captured.url).toBe("https://api.example.com/v1/chat/completions");
    expect(captured.headers.get("authorization")).toBe("Bearer k");
    // Body round-trips through the IR (stream is normalized on render).
    expect(captured.body).toMatchObject({
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    // Response is re-rendered into the source protocol.
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.content).toBe("hi back");
  });
});
