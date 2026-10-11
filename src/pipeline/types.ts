/**
 * Unified `translate` pipeline types (05.translate-api.md).
 */
import type { ApiFormat } from "../formats.js";
import type { TranslationWarning, Fidelity } from "../ir/fidelity.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";
import type { CacheAffinityResolver, PrivacySafeCacheAffinityResolver } from "../cache/resolver.js";
import type { CacheTranslationReport } from "../cache/types.js";
import type { CanonicalError } from "../errors.js";
import type { CanonicalStreamEvent } from "../streams/types.js";
import type { PrivacyCompletionReport, PrivacyOptions, PrivacyRequestTrace } from "../privacy/types.js";

/**
 * Options for a single `translate.<source>.<target>(options)` call.
 *
 * Every bit of the upstream request is supplied here; the core no longer
 * accepts a WHATWG `Request` and never reconstructs the URL, endpoint or
 * headers (05.translate-api.md §9.1/§9.2).
 */
export interface TranslateOptions {
  /** Complete, final upstream URL. Used verbatim (no path/origin rewriting). */
  url: string | URL;
  /** Source-protocol request body (JSON object or serialized JSON string). */
  body: unknown;
  /** Final upstream headers; forwarded verbatim. `content-type` defaults to JSON. */
  headers?: HeadersInit;
  /** Overrides the IR model (the body's `model` field otherwise). */
  model?: string;
  /**
   * Best-effort override of the IR `includeUsage` hint (§9.4). Unsupported
   * targets drop it silently (no warning).
   */
  includeUsage?: boolean;
  /** Explicit streaming override; falls back to the source body's `stream` field. */
  stream?: boolean;

  // ---- 观测 ----
  /** Caller-visible correlation id; generated when absent. */
  logid?: string;
  /** Request-level completion callback; fires exactly once per call. */
  onComplete?: (result: TranslateCompletion) => void;
  /** Privacy completion report, invoked once per request (privacy enabled). */
  onPrivacyComplete?: (report: PrivacyCompletionReport) => void;
  /** Diagnostic hook. Must never receive keys, credentials or prompt bodies. */
  trace?: (trace: TranslationTrace) => void;

  // ---- 执行控制 ----
  /** Upstream executor. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Upstream timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum accepted source request body size in bytes (NFR-006). Default 10 MiB. */
  maxBodyBytes?: number;
  /** Anthropic keepalive ping interval in ms while the upstream is idle. Default 15000. */
  keepAliveIntervalMs?: number;

  // ---- 能力与策略 ----
  /** Per-format provider profiles overriding the built-in defaults. */
  profiles?: Partial<Record<ApiFormat, ProviderProfile>>;
  /** Translation policies (Appendix A.3). Defaults to `DEFAULT_POLICIES`. */
  policies?: TranslationPolicies;
  /**
   * Prompt-cache affinity translation (Anthropic `cache_control` -> OpenAI
   * Chat `prompt_cache_key`). Only meaningful when the target is OpenAI Chat.
   */
  cache?: {
    /** Legacy resolvers that read the raw request/source body. */
    resolvers?: CacheAffinityResolver[];
    /** Privacy-safe resolvers that only read the redacted canonical request. */
    privacySafeResolvers?: PrivacySafeCacheAffinityResolver[];
    /** Tenant HMAC key for the built-in privacy-safe resolver. */
    key?: () => Uint8Array | Promise<Uint8Array>;
    /** Tenant namespace mixed into the HMAC seed. */
    namespace?: string;
  };
  /** Privacy recognition/redaction/restore (04.privacy-transform.md). */
  privacy?: PrivacyOptions;
  /** Opt-in debug capture of the raw SSE byte streams. */
  debug?: DebugSseOptions;
}

/** A single source->target call: options in, source-protocol `Response` out. */
export type TranslateCall<From extends ApiFormat, To extends ApiFormat> = (
  options: TranslateOptions,
) => Promise<Response>;

/** All target selectors under one source protocol. */
export type TranslateTargets<From extends ApiFormat> = {
  messages: TranslateCall<From, "anthropic-messages">;
  chat: TranslateCall<From, "openai-chat">;
  responses: TranslateCall<From, "openai-responses">;
};

/** Public `translate` entry (05.translate-api.md §3). */
export type TranslateNamespace = {
  messages: TranslateTargets<"anthropic-messages">;
  chat: TranslateTargets<"openai-chat">;
  responses: TranslateTargets<"openai-responses">;
};

export interface TranslateCompletion {
  /** Correlation id (same as the trace's `logid`/`traceId`). */
  logid: string;
  from: ApiFormat;
  to: ApiFormat;
  /** Success / caller cancellation / any error (validation, privacy, upstream). */
  status: "completed" | "cancelled" | "errored";
  /** Actual upstream request body (target protocol, JSON object). */
  requestBody?: unknown;
  /** Upstream response headers, when a response was received. */
  responseHeaders?: Headers;
  /** Upstream HTTP status code. */
  upstreamStatus?: number;
  /**
   * Non-streaming: client-final (source-protocol) response body. Under privacy
   * this is the restore-before view (placeholders, never originals).
   */
  responseBody?: unknown;
  /** Streaming: canonical SSE events (restore-before view under privacy). */
  sseEvents?: CanonicalStreamEvent[];
  /** Whether `sseEvents` hit the buffer cap and stopped accumulating. */
  sseEventsTruncated?: boolean;
  /** Unified usage (missing fields default to 0, see §7). */
  usage?: UnifiedUsage;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Normalized error on failure (undefined on success). */
  error?: CanonicalError;
}

/** Cross-protocol unified usage (05.translate-api.md §7). */
export interface UnifiedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type DebugSseSide = "upstream" | "client";

/**
 * Debug SSE capture options.
 *
 * - `capture`: which raw SSE stream(s) to capture (default `"upstream-sse"`).
 * - `onChunk`: streaming callback for each captured byte chunk.
 * - `onComplete`: called once per request with the full decoded capture.
 * - `maxBytes`: retention cap per capture (default 5 MiB); the tap keeps
 *   draining after the cap so the real stream is never blocked.
 */
export interface DebugSseOptions {
  capture?: "upstream-sse" | "client-sse" | "both";
  onChunk?: (chunk: DebugSseChunk) => void;
  onComplete?: (capture: DebugSseCapture) => void;
  maxBytes?: number;
}

export interface DebugSseChunk {
  traceId: string;
  side: DebugSseSide;
  sequence: number;
  chunk: Uint8Array;
  atMs: number;
}

export interface DebugSseCapture {
  traceId: string;
  /** Raw upstream SSE text (when captured). */
  upstream?: string;
  /** Raw client-facing SSE text (when captured). */
  client?: string;
  upstreamBytes: number;
  clientBytes: number;
  /** True when a side exceeded `maxBytes` and retention stopped early. */
  truncated: boolean;
  durationMs: number;
  completedAt: number;
}

export interface TranslationTrace {
  /** Request-scoped trace id (NFR-005); equals `logid`. */
  traceId: string;
  /** Caller-visible correlation id (05.translate-api.md §8). */
  logid: string;
  sourceFormat: ApiFormat;
  targetFormat: ApiFormat;
  sourceEndpoint: string;
  targetEndpoint: string;
  streaming: boolean;
  passthrough: boolean;
  /** Wall-clock translation time in ms (NFR-005). */
  durationMs: number;
  /** Worst fidelity observed across warnings (EXACT if none). */
  fidelity: Fidelity;
  warnings: TranslationWarning[];
  /** Request-side privacy summary (when privacy is enabled). */
  privacy?: PrivacyRequestTrace;
  /** Cache affinity summary (when `cache` is enabled on the factory). */
  cache?: CacheTranslationReport;
}
