/**
 * Offline Fixture Contract scenarios (10.4, 11.1 P0 matrix).
 *
 * For a provider with native protocol P, the scenario drives the converse
 * source protocol through translate() against a mock upstream replaying a
 * fixture, then asserts semantics on the restored source-protocol output.
 */
import type { ApiFormat } from "../../src/formats.js";
import type { ProviderProfile } from "../../src/capabilities/provider-profile.js";
import type { Scenario, ProviderConfig } from "../types.js";
import {
  assertFinishReason,
  assertNonEmptyText,
  assertStreamEndsCleanly,
  assertToolCall,
  assertUsagePresent,
} from "../assertions.js";

/** The source protocol that speaks *to* a provider of `protocol`. */
export function converseProtocol(protocol: ApiFormat): ApiFormat {
  return protocol === "openai-chat"
    ? "anthropic-messages"
    : protocol === "anthropic-messages"
      ? "openai-chat"
      : protocol;
}

const REQ_FILE: Record<ApiFormat, string> = {
  "openai-chat": "requests/openai-text.json",
  "anthropic-messages": "requests/anthropic-text.json",
  "openai-responses": "requests/openai-text.json",
};

const REQ_TOOL_FILE: Record<ApiFormat, string> = {
  "openai-chat": "requests/openai-tool.json",
  "anthropic-messages": "requests/anthropic-tool.json",
  "openai-responses": "requests/openai-tool.json",
};

const RESP_FILE: Record<ApiFormat, string> = {
  "openai-chat": "responses/openai-text.json",
  "anthropic-messages": "responses/anthropic-text.json",
  "openai-responses": "responses/openai-text.json",
};

const RESP_TOOL_FILE: Record<ApiFormat, string> = {
  "openai-chat": "responses/openai-tool.json",
  "anthropic-messages": "responses/anthropic-tool.json",
  "openai-responses": "responses/openai-tool.json",
};

const STREAM_FILE: Record<ApiFormat, string> = {
  "openai-chat": "streams/openai-text.sse",
  "anthropic-messages": "streams/anthropic-text.sse",
  "openai-responses": "streams/openai-text.sse",
};

const STREAM_TOOL_FILE: Record<ApiFormat, string> = {
  "openai-chat": "streams/openai-tool.sse",
  "anthropic-messages": "streams/anthropic-tool.sse",
  "openai-responses": "streams/openai-tool.sse",
};

/** ProviderProfile override a scenario may need (e.g. declared reasoningField). */
export interface ScenarioProfiles {
  profiles?: Partial<Record<ApiFormat, ProviderProfile>>;
}

export function offlineScenariosFor(
  provider: ProviderConfig,
): Array<Scenario & ScenarioProfiles> {
  const from = converseProtocol(provider.protocol);
  if (from === provider.protocol) {
    // Same-protocol passthrough (TC-024).
    return [];
  }

  const scenarios: Array<Scenario & ScenarioProfiles> = [
    {
      id: `${provider.id}:text`,
      title: `Text non-streaming (${from} -> ${provider.protocol})`,
      tags: ["offline", "text", "non-stream"],
      requires: [],
      fixture: {
        requestFile: REQ_FILE[from],
        responseFile: RESP_FILE[provider.protocol],
        streaming: false,
      },
      assert: (ctx) => {
        assertNonEmptyText(ctx);
        assertUsagePresent(ctx);
        assertStreamEndsCleanly(ctx);
      },
    },
    {
      id: `${provider.id}:text-stream`,
      title: `Text streaming (${from} -> ${provider.protocol})`,
      tags: ["offline", "text", "stream"],
      requires: ["stream"],
      fixture: {
        requestFile: REQ_FILE[from],
        streamFile: STREAM_FILE[provider.protocol],
        streaming: true,
      },
      assert: (ctx) => {
        assertNonEmptyText(ctx);
        assertStreamEndsCleanly(ctx);
        if (provider.protocol === "openai-chat") {
          assertFinishReason(ctx, "end_turn"); // Anthropic source stop_reason
        } else {
          assertFinishReason(ctx, "stop"); // OpenAI source finish_reason
        }
      },
    },
    {
      id: `${provider.id}:tool`,
      title: `Tool call non-streaming (${from} -> ${provider.protocol})`,
      tags: ["offline", "tool", "non-stream"],
      requires: ["tools"],
      fixture: {
        requestFile: REQ_TOOL_FILE[from],
        responseFile: RESP_TOOL_FILE[provider.protocol],
        streaming: false,
      },
      assert: (ctx) => {
        const call = assertToolCall(ctx, "get_weather");
        const args = JSON.parse(call.argumentsText);
        if ((args as { city?: string }).city !== "Paris") {
          throw new Error("tool arguments mismatch: expected city=Paris");
        }
        assertFinishReason(ctx, provider.protocol === "openai-chat" ? "tool_use" : "tool_calls");
      },
    },
    {
      id: `${provider.id}:tool-stream`,
      title: `Tool call streaming (${from} -> ${provider.protocol})`,
      tags: ["offline", "tool", "stream"],
      requires: ["tools", "stream"],
      fixture: {
        requestFile: REQ_TOOL_FILE[from],
        streamFile: STREAM_TOOL_FILE[provider.protocol],
        streaming: true,
      },
      assert: (ctx) => {
        const call = assertToolCall(ctx, "get_weather");
        const args = JSON.parse(call.argumentsText);
        if ((args as { city?: string }).city !== "Paris") {
          throw new Error("tool arguments mismatch: expected city=Paris");
        }
        assertStreamEndsCleanly(ctx);
      },
    },
    {
      id: `${provider.id}:thinking-stream`,
      title: `Thinking stream (${from} -> ${provider.protocol})`,
      tags: ["offline", "thinking", "stream"],
      requires:
        provider.protocol === "anthropic-messages"
          ? ["thinking"]
          : ["chat_reasoning_extension"],
      fixture: {
        requestFile: REQ_FILE[from],
        streamFile:
          provider.protocol === "anthropic-messages"
            ? "streams/anthropic-thinking.sse"
            : "streams/openai-thinking.sse",
        streaming: true,
      },
      // Declare the OpenAI reasoning field so the translated stream can carry
      // it (TH-003, never guessed from the model name).
      profiles:
        provider.protocol === "anthropic-messages"
          ? {
              "openai-chat": {
                protocol: "openai-chat",
                capabilities: {
                  tools: true,
                  parallelTools: true,
                  streaming: true,
                  thinking: true,
                  reasoningField: "reasoning_content",
                },
                defaultHeaders: {},
              },
            }
          : undefined,
      assert: (ctx) => {
        // Never assert the private reasoning text; assert structure: text is
        // present and the stream ends cleanly (10.5).
        assertNonEmptyText(ctx);
        assertStreamEndsCleanly(ctx);
      },
    },
    {
      id: `${provider.id}:error-reverse`,
      title: `Upstream error reverse translation (${from} -> ${provider.protocol})`,
      tags: ["offline", "error"],
      requires: [],
      fixture: {
        requestFile: REQ_FILE[from],
        responseFile: "responses/openai-error.json",
        streaming: false,
      },
      assert: (ctx) => {
        // The mock returns an OpenAI 401 error; the source (converse) protocol
        // must receive an error-shaped response (TC-023).
        if (!ctx.responseBody) throw new Error("no response body");
        if (provider.protocol === "anthropic-messages") {
          // source=openai-chat: { error: { type, message } }
          const b = ctx.responseBody as Record<string, unknown>;
          if (!b.error) throw new Error("expected OpenAI error envelope");
        } else {
          // source=anthropic-messages: { type: "error", error: {...} }
          const b = ctx.responseBody as Record<string, unknown>;
          if (b.type !== "error" || !b.error) {
            throw new Error("expected Anthropic error envelope");
          }
        }
      },
    },
  ];

  return scenarios;
}
