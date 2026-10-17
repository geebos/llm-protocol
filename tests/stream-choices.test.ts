/**
 * P6 multi-candidate streaming (docs/07 §7).
 *
 * The target parser produces `choice_start`/`choice_end` per `choices[].index`.
 * A Chat target renders each candidate independently; an Anthropic source is
 * single-candidate and must fail closed on a second choice (L-2 streaming).
 */
import { describe, expect, it } from "vitest";
import { translate } from "../src/index.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";

const encoder = new TextEncoder();

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function openaiFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

async function frames(body: ReadableStream<Uint8Array> | null): Promise<SSEFrame[]> {
  if (!body) return [];
  const out: SSEFrame[] = [];
  const reader = body.pipeThrough(createSSEParser()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const twoChoiceStream =
  openaiFrame({ id: "c", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "a" }, finish_reason: null }] }) +
  openaiFrame({ id: "c", choices: [{ index: 1, delta: { role: "assistant", content: "b" }, finish_reason: null }] }) +
  openaiFrame({ id: "c", choices: [{ index: 0, delta: { content: "1" }, finish_reason: null }] }) +
  openaiFrame({ id: "c", choices: [{ index: 1, delta: { content: "2" }, finish_reason: null }] }) +
  openaiFrame({
    id: "c",
    choices: [
      { index: 0, delta: {}, finish_reason: "stop" },
      { index: 1, delta: {}, finish_reason: "stop" },
    ],
  }) +
  openaiFrame("[DONE]");

const refusalStream =
  openaiFrame({ id: "c", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", refusal: "I can't" }, finish_reason: null }] }) +
  openaiFrame({ id: "c", choices: [{ index: 0, delta: { refusal: " help with that" }, finish_reason: null }] }) +
  openaiFrame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
  openaiFrame("[DONE]");

function mockFetch(stream: string) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void input;
    void init;
    return new Response(sseStream(stream), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

describe("multi-candidate streaming (P6)", () => {
  it("renders both candidates independently on Chat -> Chat", async () => {
    const response = await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: {
        model: "gpt-4o",
        n: 2,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      fetch: mockFetch(twoChoiceStream),
    });
    const chunks = (await frames(response.body))
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as { choices: Array<{ index: number; delta: { content?: string; role?: string }; finish_reason: string | null }> });
    const text = new Map<number, string>();
    for (const chunk of chunks) {
      for (const choice of chunk.choices) {
        if (typeof choice.delta.content === "string") {
          text.set(choice.index, (text.get(choice.index) ?? "") + choice.delta.content);
        }
      }
    }
    expect(text.get(0)).toBe("a1");
    expect(text.get(1)).toBe("b2");
    const finished = chunks
      .flatMap((c) => c.choices)
      .filter((c) => c.finish_reason === "stop")
      .map((c) => c.index);
    expect(finished).toEqual([0, 1]);
  });

  it("fails closed when an Anthropic source sees a second candidate", async () => {
    const response = await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", n: 2, stream: true, messages: [{ role: "user", content: "hi" }] },
      fetch: mockFetch(twoChoiceStream),
    });
    const out = await frames(response.body);
    const errorFrame = out.find((f) => f.event === "error");
    expect(errorFrame).toBeTruthy();
    expect(errorFrame!.data).toMatch(/multi-choice/);
  });

  it("round-trips a streamed refusal on Chat -> Chat", async () => {
    const response = await translate.chat.chat({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: "Bearer k" },
      body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
      fetch: mockFetch(refusalStream),
    });
    const chunks = (await frames(response.body))
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as { choices: Array<{ delta: { refusal?: string } }> });
    const refusal = chunks.map((c) => c.choices[0]?.delta.refusal ?? "").join("");
    expect(refusal).toBe("I can't help with that");
  });
});
