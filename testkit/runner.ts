/**
 * Matrix runner (10.4/10.6).
 *
 * For each provider, builds its scenarios, gates on capabilities and key
 * availability, executes through the public translate() handler (fixture mock
 * or real upstream), runs the scenario assertions, and enforces the request
 * budget. Live scenarios are skipped — never failed — without a key.
 */
import type { ApiFormat } from "../src/formats.js";
import type { ProviderProfile } from "../src/capabilities/provider-profile.js";
import { translate } from "../src/pipeline/translate.js";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";
import type { TranslationTrace } from "../src/pipeline/types.js";
import {
  loadFixtureResponse,
  mockProviderFetch,
} from "./fixtures.js";
import { buildFixtureRequest } from "./scenarios/fixtures-request.js";
import { hasProviderKey, providerApiKey } from "./providers.js";
import type {
  AssertionContext,
  ProviderConfig,
  RunResult,
  Scenario,
  ScenarioResult,
} from "./types.js";
import type { ScenarioProfiles } from "./scenarios/offline.js";

const SOURCE_PATH: Record<ApiFormat, string> = {
  "openai-chat": "/v1/chat/completions",
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/v1/responses",
};

/**
 * Join a base URL and a protocol path, deduplicating a trailing `/v1` on the
 * base (common with proxy gateways, e.g. `https://gw.example.com/v1`).
 */
function joinBase(baseUrl: string, path: string): string {
  let base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1")) {
    base = base.slice(0, -3);
  }
  return `${base}${path}`;
}

export interface MatrixOptions {
  providers: ProviderConfig[];
  scenarioBuilder: (provider: ProviderConfig) => Array<Scenario & ScenarioProfiles>;
  offlineOnly?: boolean;
  budget?: { maxRequests?: number };
  tags?: string[];
}

export async function runMatrix(opts: MatrixOptions): Promise<RunResult> {
  const maxRequests = opts.budget?.maxRequests ?? Infinity;
  let requestUsed = 0;
  const results: ScenarioResult[] = [];
  const tags = opts.tags;

  for (const provider of opts.providers) {
    const scenarios = opts
      .scenarioBuilder(provider)
      .filter((s) => !tags || tags.some((t) => s.tags.includes(t)));

    for (const scenario of scenarios) {
      if (requestUsed >= maxRequests) {
        results.push({
          scenarioId: scenario.id,
          providerId: provider.id,
          status: "skipped",
          skipReason: "budget exhausted",
          durationMs: 0,
          requestCount: 0,
        });
        continue;
      }
      const outcome = await runScenario(provider, scenario, {
        offlineOnly: opts.offlineOnly,
        budgetRemaining: maxRequests - requestUsed,
      });
      requestUsed += outcome.requestCount;
      results.push(outcome);
    }
  }

  return {
    startedAt: new Date().toISOString(),
    results,
    budget: { maxRequests, requestUsed },
  };
}

async function runScenario(
  provider: ProviderConfig,
  scenario: Scenario,
  opts: { offlineOnly?: boolean; budgetRemaining: number },
): Promise<ScenarioResult> {
  const started = Date.now();
  const skip = missingCapabilities(provider, scenario);
  if (skip) {
    return {
      scenarioId: scenario.id,
      providerId: provider.id,
      status: "skipped",
      skipReason: skip,
      durationMs: 0,
      requestCount: 0,
    };
  }

  const isLive = scenario.live !== undefined;
  if (isLive && (opts.offlineOnly || !hasProviderKey(provider))) {
    return {
      scenarioId: scenario.id,
      providerId: provider.id,
      status: "skipped",
      skipReason: opts.offlineOnly
        ? "offline-only run"
        : `missing ${provider.apiKeyEnv}`,
      durationMs: 0,
      requestCount: 0,
    };
  }

  try {
    const requestCount = await executeScenario(provider, scenario, opts.budgetRemaining);
    return {
      scenarioId: scenario.id,
      providerId: provider.id,
      status: "passed",
      durationMs: Date.now() - started,
      requestCount,
    };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      providerId: provider.id,
      status: "failed",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      requestCount: 1,
    };
  }
}

function missingCapabilities(
  provider: ProviderConfig,
  scenario: Scenario,
): string | undefined {
  const missing = scenario.requires.filter(
    (c) => !provider.capabilities.includes(c),
  );
  return missing.length ? `provider lacks: ${missing.join(",")}` : undefined;
}

async function executeScenario(
  provider: ProviderConfig,
  scenario: Scenario,
  budgetRemaining: number,
): Promise<number> {
  const from = converseFor(provider.protocol);
  const profiles = (scenario as Scenario & ScenarioProfiles).profiles;

  let trace: TranslationTrace | undefined;
  let targetRequestBody: unknown = null;

  const { request: baseRequest, messages: priorMessages } =
    await buildSourceRequest(provider, scenario);
  const fetch = await buildExecutor(provider, scenario, (body) => {
    targetRequestBody = body;
  });

  const handler = translate({
    from,
    to: provider.protocol,
    fetch,
    profiles: profiles as Partial<Record<ApiFormat, ProviderProfile>> | undefined,
    trace: (t) => {
      trace = t;
    },
  });

  // Live tool scenario: first turn produces a tool call, we execute it and
  // re-inject the result for a second turn (TC-006). Turn 1 asserts the tool
  // call; turn 2 asserts the model consumed the tool_result (text answer).
  if (scenario.live?.mode === "tool" && scenario.live.toolResultSecondTurn) {
    const firstResponse = await handler(baseRequest);
    const firstCtx = await collectCtx(
      provider,
      scenario,
      baseRequest,
      targetRequestBody,
      firstResponse,
      trace,
    );
    scenario.assert(firstCtx);
    const call = extractFirstToolCall(firstCtx);
    const toolResult = runBuiltinTool(call.name, JSON.parse(call.argumentsText));
    const secondRequest = buildSecondTurnRequest(
      from,
      baseRequest,
      call,
      toolResult,
      provider,
      priorMessages,
    );
    const secondResponse = await handler(secondRequest);
    const secondCtx = await collectCtx(
      provider,
      scenario,
      secondRequest,
      targetRequestBody,
      secondResponse,
      trace,
    );
    const secondAssert = scenario.secondTurnAssert ?? scenario.assert;
    await secondAssert(secondCtx);
    return 2;
  }

  const response = await handler(baseRequest);
  const ctx = await collectCtx(
    provider,
    scenario,
    baseRequest,
    targetRequestBody,
    response,
    trace,
  );
  scenario.assert(ctx);
  return 1;
}

function converseFor(protocol: ApiFormat): ApiFormat {
  return protocol === "openai-chat"
    ? "anthropic-messages"
    : protocol === "anthropic-messages"
      ? "openai-chat"
      : protocol;
}

async function buildSourceRequest(
  provider: ProviderConfig,
  scenario: Scenario,
): Promise<{ request: Request; messages: unknown[] }> {
  const from = converseFor(provider.protocol);
  const origin = provider.baseUrl || "https://mock.invalid";
  // Base URLs often end with /v1 (proxy gateways); avoid /v1/v1/...
  const url = joinBase(origin, SOURCE_PATH[from]);
  const streaming = scenario.fixture?.streaming === true;

  if (scenario.fixture) {
    const { body } = await buildFixtureRequest(
      scenario.fixture.requestFile,
      streaming,
    );
    const messages = (body.messages as unknown[]) ?? [];
    return { request: makeRequest(url, from, body, provider), messages };
  }
  // live
  const live = scenario.live!;
  const messages: unknown[] = [
    { role: "user", content: live.prompt ?? "hi" },
  ];
  const body: Record<string, unknown> = {
    model: provider.model,
    stream: live.mode === "stream",
    messages,
  };
  if (live.maxTokens) body.max_tokens = live.maxTokens;
  if (live.tools) body.tools = live.tools;
  return { request: makeRequest(url, from, body, provider), messages };
}

function makeRequest(
  url: string,
  from: ApiFormat,
  body: Record<string, unknown>,
  provider: ProviderConfig,
): Request {
  const key = providerApiKey(provider);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (from === "openai-chat") {
    if (key) headers.authorization = `Bearer ${key}`;
  } else if (from === "anthropic-messages") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function buildExecutor(
  provider: ProviderConfig,
  scenario: Scenario,
  onTargetRequest: (body: unknown) => void,
): Promise<typeof fetch> {
  if (scenario.fixture) {
    const payload = await loadFixtureResponse(scenario.fixture);
    const { fetch } = mockProviderFetch(provider, payload);
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      try {
        onTargetRequest(await req.clone().json());
      } catch {
        /* non-JSON target body */
      }
      return fetch(req);
    };
  }
  return globalThis.fetch;
}

async function collectCtx(
  provider: ProviderConfig,
  scenario: Scenario,
  request: Request,
  targetRequestBody: unknown,
  response: Response,
  trace: TranslationTrace | undefined,
): Promise<AssertionContext> {
  let requestBody: unknown = null;
  try {
    requestBody = await request.clone().json();
  } catch {
    /* ignore */
  }
  const isStreaming = scenario.fixture?.streaming === true || scenario.live?.mode === "stream";
  const ctx: AssertionContext = {
    provider,
    scenario,
    requestBody,
    targetRequestBody,
    trace,
  };
  if (isStreaming && response.body) {
    const frames = await readFrames(response.body);
    ctx.streamFrames = frames;
    ctx.streamText = aggregateOpenAiText(frames) ?? aggregateAnthropicText(frames);
  } else {
    ctx.responseBody = await response.json();
  }
  return ctx;
}

async function readFrames(body: ReadableStream<Uint8Array>): Promise<SSEFrame[]> {
  const frames: SSEFrame[] = [];
  const reader = body.pipeThrough(createSSEParser()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(value);
  }
  return frames;
}

function aggregateOpenAiText(frames: SSEFrame[]): string | undefined {
  const parts: string[] = [];
  let sawData = false;
  for (const f of frames) {
    if (f.data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(f.data) as {
        object?: string;
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      if (chunk.object !== "chat.completion.chunk") continue;
      sawData = true;
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === "string") parts.push(content);
    } catch {
      /* ignore */
    }
  }
  return sawData ? parts.join("") : undefined;
}

function aggregateAnthropicText(frames: SSEFrame[]): string | undefined {
  const parts: string[] = [];
  let sawStart = false;
  for (const f of frames) {
    if (f.event === "message_start") sawStart = true;
    if (f.event !== "content_block_delta") continue;
    try {
      const data = JSON.parse(f.data) as {
        delta?: { type?: string; text?: unknown };
      };
      if (data.delta?.type === "text_delta" && typeof data.delta.text === "string") {
        parts.push(data.delta.text);
      }
    } catch {
      /* ignore */
    }
  }
  return sawStart ? parts.join("") : undefined;
}

function extractFirstToolCall(ctx: AssertionContext): {
  id: string;
  name: string;
  argumentsText: string;
} {
  const calls: Array<{ id: string; name: string; argumentsText: string }> = [];
  const b = ctx.responseBody as Record<string, unknown> | undefined;
  if (b?.object === "chat.completion") {
    const msg = ((b.choices as Array<Record<string, unknown>>)?.[0]?.message ?? {}) as Record<string, unknown>;
    const tcs = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (tcs) {
      for (const tc of tcs) {
        calls.push({
          id: tc.id as string,
          name: (tc.function as Record<string, unknown>).name as string,
          argumentsText: (tc.function as Record<string, unknown>).arguments as string,
        });
      }
    }
  }
  if (b?.type === "message") {
    const content = (b.content as Array<Record<string, unknown>>) ?? [];
    for (const p of content) {
      if (p.type === "tool_use") {
        calls.push({
          id: p.id as string,
          name: p.name as string,
          argumentsText: JSON.stringify(p.input ?? {}),
        });
      }
    }
  }
  if (calls.length === 0) throw new Error("no tool call returned by upstream");
  return calls[0];
}

/** Builtin deterministic tools executed by the testkit (never real side effects). */
function runBuiltinTool(name: string, args: Record<string, unknown>): string {
  if (name === "get_weather") {
    const city = String(args.city ?? "unknown");
    return JSON.stringify({ weather: "sunny", temperature: 21, city });
  }
  throw new Error(`testkit has no builtin tool named "${name}"`);
}

function buildSecondTurnRequest(
  from: ApiFormat,
  firstRequest: Request,
  call: { id: string; name: string; argumentsText: string },
  toolResult: string,
  provider: ProviderConfig,
  priorMessages: unknown[],
): Request {
  const messages = [...priorMessages];
  const assistantToolMessage =
    from === "openai-chat"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.argumentsText },
            },
          ],
        }
      : {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: JSON.parse(call.argumentsText),
            },
          ],
        };
  messages.push(assistantToolMessage);
  messages.push(
    from === "openai-chat"
      ? { role: "tool", tool_call_id: call.id, content: toolResult }
      : {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: toolResult },
          ],
        },
  );
  const body = { model: provider.model, messages };
  const headers = new Headers(firstRequest.headers);
  headers.set("content-type", "application/json");
  return new Request(firstRequest.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: firstRequest.signal,
  });
}
