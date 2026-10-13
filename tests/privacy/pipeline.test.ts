/**
 * Privacy transform through the public translate API (P2/P3/P5).
 * Covers PT-01/03/04/07/16/17/31/42/50.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import {
  createSSEParser,
  type SSEFrame,
} from "../../src/streams/index.js";
import type {
  PrivacyCompletionReport,
  PrivacyRecognizer,
} from "../../src/index.js";

const encoder = new TextEncoder();

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf("13800138000");
      while (idx !== -1) {
        out.push({ start: idx, end: idx + 11, type: "phone" });
        idx = text.indexOf("13800138000", idx + 1);
      }
      return out;
    },
  };
}

interface Capture {
  fetch: typeof fetch;
  lastBody: () => unknown;
  lastHeaders: () => Headers;
}

function capturingFetch(
  handler: (req: Request) => Response | Promise<Response>,
): Capture {
  let body: unknown;
  let headers: Headers | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    headers = new Headers(req.headers);
    body = await req.json();
    return handler(req);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    lastBody: () => body,
    lastHeaders: () => {
      if (!headers) throw new Error("fetch was never called");
      return headers;
    },
  };
}

function openaiOptions(overrides: Record<string, unknown> = {}): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "sk-key" },
    body: {
      model: "gpt-4o",
      max_tokens: 256,
      messages: [{ role: "user", content: "please call 13800138000 today" }],
      ...overrides,
    },
  };
}

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Sure, I will call <private_placeholder_phone_1>." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
};

async function collectSSEFrames(
  body: ReadableStream<Uint8Array> | null,
): Promise<SSEFrame[]> {
  if (!body) return [];
  const frames: SSEFrame[] = [];
  const reader = body.pipeThrough(createSSEParser()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(value);
  }
  return frames;
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicTextStream(textChunks: string[]): string {
  let out =
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        usage: {},
      },
    }) +
    anthropicFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  for (const chunk of textChunks) {
    out += anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
  }
  out +=
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 8, output_tokens: 4 },
    }) +
    anthropicFrame("message_stop", { type: "message_stop" });
  return out;
}

function bytesStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("privacy through translate", () => {
  it("redacts the upstream request and restores the response (PT-01/03)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    const outbound = JSON.stringify(cap.lastBody());
    expect(outbound).not.toContain("13800138000");
    expect(outbound).toContain("<private_placeholder_phone_1>");

    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0].message.content).toBe(
      "Sure, I will call 13800138000.",
    );
  });

  it("injects the default system notice without redacting it (PT-42/50)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    const body = cap.lastBody() as { system?: unknown };
    const system = JSON.stringify(body.system);
    expect(system).toContain("Privacy notice");
    expect(system).toContain("<private_placeholder_{type}_{N}>");
  });

  it("restores a same-protocol response under privacy (PT-17)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "call <private_placeholder_phone_1>" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await translate.chat.chat({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("call 13800138000");
  });

  it("never leaks raw values or warnings into the trace (PT-16)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    let traceJson = "";
    await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      trace: (t) => {
        traceJson = JSON.stringify(t);
      },
    });
    expect(traceJson).not.toContain("13800138000");
  });

  it("exposes a sanitized privacy request trace (PR-012)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    let privacy: import("../../src/index.js").TranslationTrace["privacy"];
    await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      trace: (t) => {
        privacy = t.privacy;
      },
    });
    expect(privacy?.redacted).toBeGreaterThan(0);
    expect(privacy?.channelsCovered).toContain("message_text");
    expect(JSON.stringify(privacy)).not.toContain("13800138000");
  });

  it("reports completion with the security mode (PT-31)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    let report: PrivacyCompletionReport | undefined;
    await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    expect(report?.status).toBe("completed");
    expect(report?.securityMode).toBe("strict");
    expect(report?.redacted).toBeGreaterThan(0);
    expect(report?.restored).toBe(1);
    expect(report?.degraded).toBe(false);
  });

  it("leaves unknown placeholders unrestored (PT-07)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            ...anthropicResponse,
            content: [{ type: "text", text: "see <private_placeholder_phone_9>" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await translate.chat.messages({
      ...openaiOptions(),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("see <private_placeholder_phone_9>");
  });

  it("restores a placeholder split across streaming deltas (PT-04)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          bytesStream(
            anthropicTextStream([
              "Sure, call <private_",
              "placeholder_phone_1>",
              " now.",
            ]),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    let report: PrivacyCompletionReport | undefined;
    const response = await translate.chat.messages({
      ...openaiOptions({ stream: true }),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    const frames = await collectSSEFrames(response.body);
    const text = frames
      .map((f) => {
        try {
          const parsed = JSON.parse(f.data) as {
            choices?: { delta?: { content?: string } }[];
          };
          return parsed.choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(text).toBe("Sure, call 13800138000 now.");
    expect(report?.status).toBe("completed");
    expect(report?.restored).toBeGreaterThanOrEqual(1);
  });

  it("reports cancellation when the client stops consuming (PT-30/41)", async () => {
    const initial =
      anthropicFrame("message_start", {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: {} },
      }) +
      anthropicFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      });
    const cap = capturingFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(initial));
              // Never closes: simulates a long-lived stream.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    let report: PrivacyCompletionReport | undefined;
    const response = await translate.chat.messages({
      ...openaiOptions({ stream: true }),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(report?.status).toBe("cancelled");
  });

  it("reports errored when the upstream body fails mid-stream (PT-13)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  anthropicFrame("message_start", {
                    type: "message_start",
                    message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: {} },
                  }),
                ),
              );
              controller.error(new Error("upstream body failed"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    let report: PrivacyCompletionReport | undefined;
    const response = await translate.chat.messages({
      ...openaiOptions({ stream: true }),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
      onPrivacyComplete: (r) => {
        report = r;
      },
    });
    await expect(collectSSEFrames(response.body)).rejects.toBeTruthy();
    expect(report?.status).toBe("errored");
  });
});
