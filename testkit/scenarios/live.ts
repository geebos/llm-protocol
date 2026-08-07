/**
 * Live smoke scenarios (10.4, TC-001/002/004/005/009).
 *
 * These hit real providers through the public translate() handler and the
 * official SDKs. They only run when the provider's API key is present and the
 * run is not offline-only (10.6: skipped otherwise, never fails the suite).
 */
import type { ApiFormat } from "../../src/formats.js";
import type { Scenario, ProviderConfig } from "../types.js";
import { assertToolCall, assertParallelToolCalls, assertReasoningThenText } from "../assertions.js";
import type { ScenarioProfiles } from "./offline.js";

const WEATHER_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

const ANTHROPIC_WEATHER_TOOL = [
  {
    name: "get_weather",
    description: "Get the weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

/** The converse source protocol that speaks to a provider. */
export function converse(protocol: ApiFormat): ApiFormat {
  return protocol === "openai-chat"
    ? "anthropic-messages"
    : protocol === "anthropic-messages"
      ? "openai-chat"
      : protocol;
}

export function liveScenariosFor(provider: ProviderConfig): Array<Scenario & ScenarioProfiles> {
  const from = converse(provider.protocol);
  // The request body (and its tools) uses the *source* protocol.
  const sourceTools = from === "openai-chat" ? WEATHER_TOOL : ANTHROPIC_WEATHER_TOOL;

  const scenarios: Array<Scenario & ScenarioProfiles> = [
    {
      id: `${provider.id}:live-text`,
      title: `Live text non-streaming (${from} -> ${provider.protocol})`,
      tags: ["live", "text", "non-stream"],
      requires: [],
      live: { mode: "text", prompt: "Reply with exactly: pong", maxTokens: 256 },
      assert: (ctx) => {
        const b = ctx.responseBody as Record<string, unknown> | undefined;
        if (!b) throw new Error("no response body");
        const text = extractText(b);
        if (!text.trim()) {
          throw new Error(`empty text reply; response=${summarizeBody(b)}`);
        }
      },
    },
    {
      id: `${provider.id}:live-text-stream`,
      title: `Live text streaming (${from} -> ${provider.protocol})`,
      tags: ["live", "text", "stream"],
      requires: ["stream"],
      live: {
        mode: "stream",
        prompt: "Reply with exactly: pong",
        maxTokens: 256,
      },
      assert: (ctx) => {
        if (!ctx.streamText?.trim()) {
          const frames = ctx.streamFrames?.slice(0, 5).map((f) => f.data).join(" | ") ?? "";
          throw new Error(`empty streamed text; first frames=${frames.slice(0, 300)}`);
        }
        if (!ctx.streamFrames?.length) throw new Error("no stream frames");
      },
    },
  ];

  if (provider.capabilities.includes("tools")) {
    scenarios.push({
      id: `${provider.id}:live-tool`,
      title: `Live tool call + result re-injection (${from} -> ${provider.protocol})`,
      tags: ["live", "tool"],
      requires: ["tools"],
      live: {
        mode: "tool",
        prompt: "What is the weather in Paris? Use the tool.",
        maxTokens: 512,
        tools: sourceTools,
        toolResultSecondTurn: true,
      },
      assert: (ctx) => {
        const call = assertToolCall(ctx, "get_weather");
        const args = JSON.parse(call.argumentsText) as { city?: string };
        if (!args.city) throw new Error("tool arguments missing city");
      },
      secondTurnAssert: (ctx) => {
        // After re-injecting the tool_result, the model must produce a text
        // answer (proves the tool_result was understood and the conversation
        // continued).
        const b = ctx.responseBody as Record<string, unknown> | undefined;
        if (!b) throw new Error("no response body on second turn");
        const text = extractText(b);
        if (!text.trim()) throw new Error("no text answer after tool result");
      },
    });
  }

  if (provider.capabilities.includes("parallel_tools")) {
    scenarios.push({
      id: `${provider.id}:live-parallel-tool`,
      title: `Live parallel tool calls (${from} -> ${provider.protocol})`,
      tags: ["live", "tool", "parallel"],
      requires: ["parallel_tools"],
      live: {
        mode: "tool",
        prompt: "What is the weather in Paris AND in Tokyo? Call the tool for both cities in parallel.",
        maxTokens: 512,
        tools: sourceTools,
        toolResultSecondTurn: false,
      },
      assert: (ctx) => {
        // At least two parallel tool calls, distinct ids, valid JSON args.
        assertParallelToolCalls(ctx, 2);
      },
    });
  }

  if (provider.capabilities.includes("thinking") || provider.capabilities.includes("chat_reasoning_extension")) {
    // Requires must match the capability that admitted the scenario, so a
    // provider with only chat_reasoning_extension is not added-then-skipped.
    const thinkingRequires = provider.capabilities.includes("thinking")
      ? (["thinking"] as const)
      : (["chat_reasoning_extension"] as const);
    scenarios.push({
      id: `${provider.id}:live-thinking`,
      title: `Live thinking (${from} -> ${provider.protocol})`,
      tags: ["live", "thinking"],
      requires: [...thinkingRequires],
      live: {
        mode: "thinking",
        prompt: "Explain one benefit of HTTP/3 in one sentence.",
        maxTokens: 512,
      },
      assert: (ctx) => {
        // Structure-only assertion (10.5): some text is present; reasoning
        // visibility is provider-dependent and never asserted verbatim.
        const b = ctx.responseBody as Record<string, unknown> | undefined;
        if (!b) throw new Error("no response body");
        if (!extractText(b).trim()) {
          throw new Error(`empty text reply; response=${summarizeBody(b)}`);
        }
      },
    });
  }

  // Reasoning -> text ordering (tech-v2.md STREAM-001, §20 Recommended). Only
  // providers declaring a Chat reasoning field can carry thinking into the
  // source stream; the profile is set so reasoning survives translation
  // (TH-003, never guessed).
  const reasoningStreamCapable =
    provider.protocol === "openai-chat"
      ? provider.capabilities.includes("chat_reasoning_extension")
      : provider.capabilities.includes("thinking");
  if (reasoningStreamCapable) {
    scenarios.push({
      id: `${provider.id}:live-reasoning-text`,
      title: `Live reasoning -> text stream (${from} -> ${provider.protocol})`,
      tags: ["live", "thinking", "stream"],
      requires: provider.protocol === "openai-chat" ? ["chat_reasoning_extension"] : ["thinking"],
      // Declare the OpenAI Chat reasoning field so thinking survives into/out
      // of the source stream in either direction (TH-003, never guessed).
      profiles: {
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
      },
      live: {
        mode: "stream",
        prompt: "First think about HTTP/3 briefly, then answer in one sentence.",
        maxTokens: 512,
      },
      assert: (ctx) => {
        // Structure-only: reasoning deltas precede text; never assert the
        // private reasoning content itself (10.5).
        assertReasoningThenText(ctx);
        if (!ctx.streamText?.trim()) {
          throw new Error("no text content after reasoning");
        }
      },
    });
  }

  return scenarios;
}

/** Truncated, non-secret response summary for diagnostics. */
function summarizeBody(b: Record<string, unknown>): string {
  try {
    const text = extractText(b);
    const reason =
      (b as { finish_reason?: unknown }).finish_reason ??
      (b as { stop_reason?: unknown }).stop_reason;
    return JSON.stringify({ text, reason, keys: Object.keys(b) }).slice(0, 300);
  } catch {
    return JSON.stringify(b).slice(0, 300);
  }
}

function extractText(b: Record<string, unknown>): string {
  if (b.object === "chat.completion") {
    const msg = (b.choices as Array<Record<string, unknown>>)?.[0]?.message as
      | Record<string, unknown>
      | undefined;
    return typeof msg?.content === "string" ? msg.content : "";
  }
  if (b.type === "message") {
    const content = (b.content as Array<Record<string, unknown>>) ?? [];
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}
