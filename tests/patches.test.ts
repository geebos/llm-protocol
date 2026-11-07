/**
 * Opt-in request patches (`TranslateOptions.patches`).
 *
 * Patches receive the final outbound (target-protocol) body and return its
 * replacement; they run in order, before egress verification and the upstream
 * call, and can be gated with a `filter` predicate.
 */
import { describe, expect, it } from "vitest";
import {
  TranslationError,
  translate,
  type RequestPatch,
  type TranslateCompletion,
} from "../src/index.js";

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function anthropicBody(): Record<string, unknown> {
  return {
    model: "claude-sonnet",
    max_tokens: 64,
    stream: false,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: "again" },
    ],
  };
}

interface Captured {
  body: Record<string, unknown>;
}

function fakeFetch(response: () => Response): {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  lastRequest: () => Captured;
  calls: () => number;
} {
  let captured: Captured | undefined;
  let calls = 0;
  return {
    fetch: async (input, init) => {
      calls += 1;
      const request = input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      captured = { body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      return response();
    },
    lastRequest: () => {
      if (!captured) throw new Error("no request captured");
      return captured;
    },
    calls: () => calls,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderAnthropic(
  body: Record<string, unknown>,
  patches?: readonly RequestPatch[],
): Promise<{ body: Record<string, unknown>; completion: TranslateCompletion }> {
  const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
  let completion: TranslateCompletion | undefined;
  await translate.messages.messages({
    url: "https://api.example.com/v1/messages",
    headers: { "x-api-key": "test-key" },
    body,
    patches,
    fetch,
    onComplete: (result) => {
      completion = result;
    },
  });
  return { body: lastRequest().body, completion: completion! };
}

describe("request patches", () => {
  it("applies patches in order to the outbound body", async () => {
    const first: RequestPatch = {
      apply: (request) => ({ ...request, stage: "first" }),
    };
    const second: RequestPatch = {
      apply: (request) => ({ ...request, stage: `${String(request.stage)}:second` }),
    };
    const { body, completion } = await renderAnthropic(anthropicBody(), [first, second]);

    expect(body.stage).toBe("first:second");
    // The patched body is what the completion report observes and what is sent.
    expect(completion.requestBody).toEqual(body);
  });

  it("skips a patch whose filter rejects the request", async () => {
    let seen: unknown;
    const gated: RequestPatch = {
      filter: (request) => {
        seen = request.model;
        return false;
      },
      apply: (request) => ({ ...request, stage: "patched" }),
    };
    const { body } = await renderAnthropic(anthropicBody(), [gated]);

    expect(seen).toBe("claude-sonnet");
    expect(body).not.toHaveProperty("stage");
  });

  it("sends the rendered body untouched when no patch is supplied", async () => {
    const { body } = await renderAnthropic(anthropicBody());
    expect(body).not.toHaveProperty("stage");
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("fails the call as a validation error when a patch throws", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(anthropicResponse));
    const failing: RequestPatch = {
      apply: () => {
        throw new Error("boom");
      },
    };
    const error = await translate.messages
      .messages({
        url: "https://api.example.com/v1/messages",
        body: anthropicBody(),
        patches: [failing],
        fetch,
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TranslationError);
    expect((error as TranslationError).kind).toBe("validation");
    expect((error as Error).message).toBe("Request patch #1 failed: boom");
    expect(calls()).toBe(0);
  });

  it("fails the call as a validation error when a filter throws", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(anthropicResponse));
    const failing: RequestPatch = {
      filter: () => {
        throw new Error("no filter");
      },
      apply: (request) => request,
    };
    const error = await translate.messages
      .messages({
        url: "https://api.example.com/v1/messages",
        body: anthropicBody(),
        patches: [failing],
        fetch,
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TranslationError);
    expect((error as Error).message).toBe("Request patch #1 failed: no filter");
    expect(calls()).toBe(0);
  });

  it("rejects a patch that does not return a request object", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(anthropicResponse));
    const invalid = { apply: () => null } as unknown as RequestPatch;
    await expect(
      translate.messages.messages({
        url: "https://api.example.com/v1/messages",
        body: anthropicBody(),
        patches: [invalid],
        fetch,
      }),
    ).rejects.toThrowError(/request patch #1 must be a JSON object/);
    expect(calls()).toBe(0);
  });
});
