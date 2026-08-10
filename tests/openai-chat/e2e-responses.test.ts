/**
 * OpenAI Chat -> OpenAI Responses end-to-end test through translate().
 *
 * Source protocol: openai-chat. Assistant tool_calls become independent
 * Responses input items; the client receives a chat.completion response.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function responsesRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer key", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const responsesTextResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1700000000,
  status: "completed",
  model: "gpt-4o",
  output: [
    { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hello from Responses" }] },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

describe("openai-chat -> openai-responses e2e", () => {
  it("Chat -> Responses: assistant tool_calls become independent items", async () => {
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      captured = await req.json();
      return jsonResponse(responsesTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "openai-responses", fetch: fetchImpl });
    const response = await forward(
      responsesRequest("https://api.example.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      }),
    );
    // client speaks Chat: response restored to chat.completion shape
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    // upstream (Responses) request: tool calls are independent items
    const input = captured as { input?: unknown };
    const items = input.input as Array<Record<string, unknown>>;
    expect(items).toContainEqual({ type: "function_call", name: "get_weather", call_id: "call_1", arguments: "{\"city\":\"Paris\"}" });
    expect(items).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "sunny" });
  });

  it("preserves source item order: text -> reasoning -> tool_call (review P0)", async () => {
    // Chat parser builds assistant content as [text, reasoning, tool_calls];
    // the Responses renderer must NOT regroup it into [text, tool_calls,
    // reasoning] — source item order is a hard rule (responses.md §5.2, P0-4).
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      captured = await req.json();
      return jsonResponse(responsesTextResponse);
    }) as typeof fetch;
    const forward = translate({
      from: "openai-chat",
      to: "openai-responses",
      fetch: fetchImpl,
      profiles: {
        "openai-chat": {
          ...openaiChatDefaultProfile,
          capabilities: {
            ...openaiChatDefaultProfile.capabilities,
            reasoningField: "reasoning_content",
          },
        },
      },
    });
    await forward(
      responsesRequest("https://api.example.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "done thinking",
            reasoning_content: "deep reasoning",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
            ],
          },
        ],
      }),
    );
    const input = (captured as { input?: unknown }).input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type)).toEqual(["message", "message", "reasoning", "function_call"]);
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
    expect(input[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done thinking" }],
    });
    expect(input[2]).toMatchObject({ type: "reasoning" });
    expect(input[3]).toMatchObject({ type: "function_call", call_id: "call_1" });
  });

  it("maps Chat response_format to Responses text.format (review P1)", async () => {
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      captured = await req.json();
      return jsonResponse(responsesTextResponse);
    }) as typeof fetch;
    const forward = translate({ from: "openai-chat", to: "openai-responses", fetch: fetchImpl });
    await forward(
      responsesRequest("https://api.example.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "list" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "list", schema: { type: "object" } },
        },
      }),
    );
    const body = captured as Record<string, unknown>;
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "list", schema: { type: "object" } },
    });
  });

  it("maps Responses text.format back to Chat response_format (review P1)", async () => {
    let captured: unknown;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      captured = await req.json();
      return jsonResponse({
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }) as typeof fetch;
    const forward = translate({ from: "openai-responses", to: "openai-chat", fetch: fetchImpl });
    await forward(
      responsesRequest("https://api.example.com/v1/responses", {
        model: "gpt-4o",
        input: "list",
        text: { format: { type: "json_schema", name: "list", schema: { type: "object" } } },
      }),
    );
    const body = captured as Record<string, unknown>;
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "list", schema: { type: "object" } },
    });
  });
});
