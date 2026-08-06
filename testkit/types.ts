/**
 * Testkit shared types (tech.md section 10).
 *
 * The testkit is a compatibility laboratory: scenarios drive the public
 * translate() handler with real or fixture upstreams, consume the output with
 * the official SDKs or protocol validators, and emit reports. It never
 * bypasses the main API to test codecs directly (10.1).
 */
import type { ApiFormat } from "../src/formats.js";
import type { TranslationTrace } from "../src/pipeline/types.js";
import type { SSEFrame } from "../src/streams/index.js";

/** Provider capability tokens (10.2). */
export type ProviderCapability =
  | "stream"
  | "tools"
  | "parallel_tools"
  | "thinking"
  | "chat_reasoning_extension";

export interface ProviderConfig {
  id: string;
  /** The provider's native protocol (its server-side API shape). */
  protocol: ApiFormat;
  baseUrl?: string;
  /** Env var holding the API key; value is only read at request time. */
  apiKeyEnv: string;
  model: string;
  capabilities: ProviderCapability[];
}

export interface ScenarioResult {
  scenarioId: string;
  providerId: string;
  status: "passed" | "failed" | "skipped";
  /** Reason when skipped. */
  skipReason?: string;
  durationMs: number;
  error?: string;
  requestCount: number;
  trace?: TranslationTrace;
}

export interface RunResult {
  startedAt: string;
  results: ScenarioResult[];
  budget?: { maxRequests: number; requestUsed: number };
}

export interface RunOptions {
  providers: ProviderConfig[];
  scenarios: Scenario[];
  /** Skip live (real API) scenarios. */
  offlineOnly?: boolean;
  budget?: { maxRequests: number };
  /** Run only scenarios carrying at least one of these tags. */
  tags?: string[];
}

/** Fixture-driven (offline) scenario body. */
export interface FixtureSpec {
  /** `from`-protocol request fixture path under fixtures/. */
  requestFile: string;
  /** `to`-protocol non-streaming response fixture (JSON) path. */
  responseFile?: string;
  /** `to`-protocol SSE fixture path. */
  streamFile?: string;
  streaming?: boolean;
}

export interface LiveSpec {
  mode: "text" | "stream" | "tool" | "thinking";
  prompt?: string;
  maxTokens?: number;
  /** Tools offered to the model (target-protocol form, rendered by the codec). */
  tools?: unknown[];
  /** Whether the scenario sends its own tool result back for a second turn. */
  toolResultSecondTurn?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  tags: string[];
  /** Provider capabilities required to run this scenario. */
  requires: ProviderCapability[];
  fixture?: FixtureSpec;
  live?: LiveSpec;
  /** Assertions over the translated outcome. */
  assert: (ctx: AssertionContext) => void | Promise<void>;
  /**
   * Assertions for the second turn of a two-turn live flow (e.g. after a tool
   * result is re-injected). Defaults to `assert`.
   */
  secondTurnAssert?: (ctx: AssertionContext) => void | Promise<void>;
}

export interface AssertionContext {
  provider: ProviderConfig;
  scenario: Scenario;
  /** Source-protocol request body actually sent. */
  requestBody: unknown;
  /** Target-protocol request body captured by the executor. */
  targetRequestBody: unknown;
  /** Non-streaming source-protocol response body (parsed JSON). */
  responseBody?: unknown;
  /** Streamed source-protocol SSE frames. */
  streamFrames?: SSEFrame[];
  /** Plain-text concatenation of streamed content, if any. */
  streamText?: string;
  trace?: TranslationTrace;
}
