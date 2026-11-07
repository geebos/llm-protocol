/**
 * Opt-in request patches (`TranslateOptions.patches`) and the built-in DeepSeek
 * image `tool_result` thinking patch.
 *
 * Patches receive the final outbound (target-protocol) body and return its
 * replacement; the built-in patch only adds a `thinking` block to the assistant
 * messages whose image-bearing `tool_result` would otherwise be rejected.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_THINKING_PLACEHOLDER,
  TranslationError,
  deepseekImageThinkingPatch,
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

const chatResponse = {
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const imageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
};

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

/** Anthropic history: assistant issues `tool_use`, user answers with `tool_result`. */
function toolHistory(toolResultContent: unknown): Record<string, unknown> {
  return {
    model: "deepseek-v4.1-flash-1017",
    max_tokens: 64,
    stream: false,
    messages: [
      { role: "user", content: "read the screenshot" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "t1", name: "read_image", input: { path: "a.png" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: toolResultContent }],
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

function messages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = body.messages;
  if (!Array.isArray(value)) throw new Error("no messages in outbound body");
  return value as Array<Record<string, unknown>>;
}

function contentOf(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? (message.content as Array<Record<string, unknown>>)
    : [];
}

async function renderAnthropic(
  body: Record<string, unknown>,
  patches?: readonly RequestPatch[],
): Promise<{ body: Record<string, unknown>; completion: TranslateCompletion }> {
  const { fetch, lastRequest } = fakeFetch(() => jsonResponse(anthropicResponse));
  let completion: TranslateCompletion | undefined;
  await translate.messages.messages({
    url: "https://api.deepseek.com/anthropic/v1/messages",
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
    const { body, completion } = await renderAnthropic(toolHistory("done"), [first, second]);

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
    const { body } = await renderAnthropic(toolHistory("done"), [gated]);

    expect(seen).toBe("deepseek-v4.1-flash-1017");
    expect(body).not.toHaveProperty("stage");
  });

  it("sends the rendered body untouched when no patch is supplied", async () => {
    const { body } = await renderAnthropic(toolHistory("done"));
    expect(body).not.toHaveProperty("stage");
    expect(messages(body).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
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
        url: "https://api.deepseek.com/anthropic/v1/messages",
        body: toolHistory("done"),
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
        url: "https://api.deepseek.com/anthropic/v1/messages",
        body: toolHistory("done"),
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
        url: "https://api.deepseek.com/anthropic/v1/messages",
        body: toolHistory("done"),
        patches: [invalid],
        fetch,
      }),
    ).rejects.toThrowError(/request patch #1 must be a JSON object/);
    expect(calls()).toBe(0);
  });
});

describe("deepseekImageThinkingPatch", () => {
  it("adds a thinking block to the assistant message with an image tool_result", async () => {
    const { body } = await renderAnthropic(
      toolHistory([
        { type: "text", text: "saved" },
        imageBlock,
      ]),
      [deepseekImageThinkingPatch],
    );

    const assistant = messages(body)[1];
    expect(contentOf(assistant)[0]).toEqual({
      type: "thinking",
      thinking: IMAGE_THINKING_PLACEHOLDER,
    });
    // The original blocks are preserved after the inserted thinking block.
    expect(contentOf(assistant)[1]).toEqual({ type: "text", text: "reading" });
    expect(contentOf(assistant)[2]).toMatchObject({ type: "tool_use", id: "t1" });
    // The image tool_result is untouched.
    expect(JSON.stringify(messages(body)[2])).toContain('"type":"image"');
  });

  it("leaves a text-only tool_result history unchanged", async () => {
    const { body } = await renderAnthropic(toolHistory("done"), [deepseekImageThinkingPatch]);
    expect(contentOf(messages(body)[1]).some((b) => b.type === "thinking")).toBe(false);
  });

  it("keeps an existing signed thinking block", async () => {
    const history = toolHistory([imageBlock]);
    const assistant = (history.messages as Array<Record<string, unknown>>)[1];
    assistant.content = [
      { type: "thinking", thinking: "real reasoning", signature: "sig-1" },
      { type: "tool_use", id: "t1", name: "read_image", input: {} },
    ];

    const { body } = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    const blocks = contentOf(messages(body)[1]);
    expect(blocks.filter((b) => b.type === "thinking")).toEqual([
      { type: "thinking", thinking: "real reasoning", signature: "sig-1" },
    ]);
  });

  it("accepts redacted_thinking as an existing thinking block", async () => {
    const history = toolHistory([imageBlock]);
    const assistant = (history.messages as Array<Record<string, unknown>>)[1];
    assistant.content = [
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "t1", name: "read_image", input: {} },
    ];

    const { body } = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    const kinds = contentOf(messages(body)[1]).map((b) => b.type);
    expect(kinds).toEqual(["redacted_thinking", "tool_use"]);
  });

  it("replaces a blank thinking block instead of duplicating it", async () => {
    const history = toolHistory([imageBlock]);
    const assistant = (history.messages as Array<Record<string, unknown>>)[1];
    assistant.content = [
      { type: "thinking", thinking: "   " },
      { type: "tool_use", id: "t1", name: "read_image", input: {} },
    ];

    const rendered = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    const blocks = contentOf(messages(rendered.body)[1]);
    expect(blocks.filter((b) => b.type === "thinking")).toEqual([
      { type: "thinking", thinking: IMAGE_THINKING_PLACEHOLDER },
    ]);
  });

  it("ignores a tool_result that answers a different tool_use id", () => {
    const history = toolHistory([imageBlock]);
    const toolResult = ((history.messages as Array<Record<string, unknown>>)[2]
      .content as Array<Record<string, unknown>>)[0];
    toolResult.tool_use_id = "other";

    const patched = deepseekImageThinkingPatch.apply(history);
    expect(contentOf(messages(patched)[1]).some((b) => b.type === "thinking")).toBe(false);
  });

  it("returns a new request object without mutating the input", () => {
    const history = toolHistory([imageBlock]);
    const before = structuredClone(history);

    const patched = deepseekImageThinkingPatch.apply(history);

    expect(history).toEqual(before);
    expect(patched).not.toBe(history);
  });

  it("ignores images outside a tool_result", async () => {
    const history = toolHistory("done");
    (history.messages as Array<Record<string, unknown>>)[0].content = [
      { type: "text", text: "look" },
      imageBlock,
    ];

    const { body } = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    expect(JSON.stringify(body)).not.toContain('"type":"thinking"');
  });

  it("skips models whose id does not start with deepseek", async () => {
    const history = toolHistory([imageBlock]);
    history.model = "claude-sonnet-4-5";

    const { body } = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    expect(JSON.stringify(body)).not.toContain('"type":"thinking"');
  });

  it("treats the model id as a prefix match, not a substring match", async () => {
    const history = toolHistory([imageBlock]);
    history.model = "vendor/deepseek-v4.1-flash-1017";

    const { body } = await renderAnthropic(history, [deepseekImageThinkingPatch]);
    expect(JSON.stringify(body)).not.toContain('"type":"thinking"');
  });

  it("does not touch OpenAI Chat bodies", async () => {
    const { fetch, lastRequest } = fakeFetch(() => jsonResponse(chatResponse));
    await translate.messages.chat({
      url: "https://api.deepseek.com/v1/chat/completions",
      body: toolHistory([imageBlock]),
      patches: [deepseekImageThinkingPatch],
      fetch,
    });
    const body = lastRequest().body;
    expect(JSON.stringify(body)).not.toContain('"thinking"');
    const assistant = messages(body)[1];
    expect(assistant.tool_calls).toBeDefined();
  });
});
