/**
 * Multi-candidate response (docs/07 §5.3, L-2) and first-class refusal.
 */
import { describe, expect, it } from "vitest";
import { translate, type TranslationTrace } from "../../src/index.js";

function fakeFetch(response: () => Response): {
  fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
} {
  return {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      await request.text();
      return response();
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const multiChoice = {
  id: "chatcmpl_1",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [
    { index: 0, message: { role: "assistant", content: "first" }, finish_reason: "stop" },
    { index: 1, message: { role: "assistant", content: "second" }, finish_reason: "length" },
  ],
};

const refusal = {
  id: "chatcmpl_2",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, refusal: "I cannot help with that" },
      finish_reason: "stop",
    },
  ],
};

describe("multi-choice response (L-2)", () => {
  it("keeps every choice on Chat -> Chat", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(multiChoice));
    const response = await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    const body = (await response.json()) as { choices: Array<Record<string, unknown>> };
    expect(body.choices).toHaveLength(2);
    expect((body.choices[0].message as Record<string, unknown>).content).toBe("first");
    expect((body.choices[1].message as Record<string, unknown>).content).toBe("second");
    expect(body.choices[1].finish_reason).toBe("length");
  });

  it("returns a source-protocol error Response on a multi-choice response for an Anthropic target (L-5)", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(multiChoice));
    const traces: TranslationTrace[] = [];
    const response = await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      fetch,
      trace: (t) => traces.push(t),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.message).toMatch(/not representable/);
    expect(traces[0].failurePhase).toBe("projection");
  });
});

describe("first-class refusal part", () => {
  it("round-trips message.refusal on Chat -> Chat", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(refusal));
    const response = await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    const body = (await response.json()) as { choices: Array<Record<string, unknown>> };
    const message = body.choices[0].message as Record<string, unknown>;
    expect(message.refusal).toBe("I cannot help with that");
  });

  it("renders a Chat-upstream refusal as Anthropic text", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(refusal));
    const response = await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      fetch,
    });
    const body = (await response.json()) as { content: unknown[] };
    expect(body.content).toContainEqual({ type: "text", text: "I cannot help with that" });
  });
});
