/**
 * Anthropic server tools (docs/07 §5.5, §5.9; A-option fix).
 *
 * `type` + type-specific parameters are native-to-Anthropic: preserved verbatim
 * on a Messages -> Messages round trip, and fail-closed (never converted into an
 * empty client function tool) when the target protocol cannot express them.
 */
import { describe, expect, it } from "vitest";
import { translate, type TranslationTrace } from "../../src/index.js";

const PHONE = "13800138000";

interface Capture {
  fetch: typeof fetch;
  lastBody: () => Record<string, unknown>;
}

function capturingFetch(handler: () => Response): Capture {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init);
    body = (await request.json()) as Record<string, unknown>;
    return handler();
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    lastBody: () => {
      if (!body) throw new Error("fetch was never called");
      return body;
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

function requestBody(tools: unknown[]): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    tools,
  };
}

function phoneRecognizer() {
  return {
    priority: 1,
    recognize: (text: string) => {
      const i = text.indexOf(PHONE);
      return i < 0 ? [] : [{ start: i, end: i + PHONE.length, type: "phone" }];
    },
  };
}

async function translateMessagesToMessages(
  tools: unknown[],
  options: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; trace?: TranslationTrace | undefined }> {
  const capture = capturingFetch(() => jsonResponse(anthropicResponse));
  let trace: TranslationTrace | undefined;
  await translate.messages.messages({
    url: "https://api.anthropic.com/v1/messages",
    body: JSON.stringify(requestBody(tools)),
    fetch: capture.fetch,
    trace: (value) => {
      trace = value;
    },
    ...options,
  });
  return { body: capture.lastBody(), trace };
}

describe("Anthropic server tools", () => {
  it("round-trips type and type-specific parameters without synthesizing input_schema", async () => {
    const { body, trace } = await translateMessagesToMessages([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]);

    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    });
    expect(tools[0]).not.toHaveProperty("input_schema");
    expect(tools[1]).toEqual({
      name: "get_weather",
      input_schema: { type: "object", properties: {} },
    });
    expect(trace?.warnings).toEqual([]);
    expect(trace?.drops ?? []).toEqual([]);
  });

  it("keeps a server tool cache breakpoint alongside its type", async () => {
    const { body } = await translateMessagesToMessages([
      {
        type: "computer_20250124",
        name: "computer",
        display_width_px: 1024,
        display_height_px: 768,
        display_number: 1,
        cache_control: { type: "ephemeral" },
      },
    ]);

    expect((body.tools as Record<string, unknown>[])[0]).toEqual({
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 1,
      cache_control: { type: "ephemeral" },
    });
  });

  it("normalizes the implicit `custom` type and keeps custom-tool residue", async () => {
    const { body } = await translateMessagesToMessages([
      {
        type: "custom",
        name: "get_weather",
        input_schema: { type: "object" },
        input_examples: [{ city: "Paris" }],
      },
    ]);

    expect((body.tools as Record<string, unknown>[])[0]).toEqual({
      name: "get_weather",
      input_schema: { type: "object" },
      input_examples: [{ city: "Paris" }],
    });
  });

  it("rejects a non-string or empty tool type", async () => {
    await expect(
      translateMessagesToMessages([{ type: 7, name: "web_search" }]),
    ).rejects.toThrow(/tools\[0\]\.type must be a non-empty string/);
    await expect(
      translateMessagesToMessages([{ type: "", name: "web_search" }]),
    ).rejects.toThrow(/tools\[0\]\.type must be a non-empty string/);
  });

  it("fails closed when the target cannot express a server tool", async () => {
    const capture = capturingFetch(() => jsonResponse(chatResponse));
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        body: JSON.stringify(requestBody([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }])),
        fetch: capture.fetch,
      }),
    ).rejects.toMatchObject({
      kind: "unsupported",
      code: "non_droppable_field",
      message: expect.stringContaining("tools[0].native.anthropic.type"),
    });
  });

  it("still translates ordinary custom tools to Chat functions", async () => {
    const capture = capturingFetch(() => jsonResponse(chatResponse));
    await translate.messages.chat({
      url: "https://api.openai.com/v1/chat/completions",
      body: JSON.stringify(
        requestBody([{ name: "get_weather", description: "d", input_schema: { type: "object" } }]),
      ),
      fetch: capture.fetch,
    });
    expect(capture.lastBody().tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "d", parameters: { type: "object" } },
      },
    ]);
  });

  it("redacts a configured server-tool native field in place", async () => {
    const { body } = await translateMessagesToMessages(
      [{ type: "web_search_20250305", name: "web_search", user_location: `call ${PHONE}` }],
      {
        privacy: {
          recognizers: [phoneRecognizer()],
          coverage: { native: { "anthropic.extra": "redact" } },
        },
      },
    );

    const tool = (body.tools as Record<string, unknown>[])[0];
    expect(tool.name).toBe("web_search");
    expect(JSON.stringify(tool)).not.toContain(PHONE);
    expect(String(tool.user_location)).toMatch(/private_placeholder_phone_\d+/);
  });
});
