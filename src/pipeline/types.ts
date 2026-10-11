/**
 * Pipeline types (9.1, 9.12).
 */
import type { ApiFormat } from "../formats.js";
import type { TranslationWarning, Fidelity } from "../ir/fidelity.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";
import type { CacheAffinityResolver, PrivacySafeCacheAffinityResolver } from "../cache/resolver.js";
import type { CacheTranslationReport } from "../cache/types.js";
import type { PrivacyCompletionReport, PrivacyOptions, PrivacyRequestTrace } from "../privacy/types.js";

export interface TranslateOptions<From extends ApiFormat, To extends ApiFormat> {
  from: From;
  to: To;

  /**
   * Upstream executor. Defaults to `globalThis.fetch`; injectable for tests,
   * recording, fault injection or custom connection pools. The core never
   * manages API keys, URL routing or tenants (FR-005B).
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Optional per-format provider profiles overriding the built-in defaults.
   * Needed to declare provider-specific capabilities such as a Chat
   * `reasoningField` (TH-003) without guessing from model names.
   */
  profiles?: Partial<Record<ApiFormat, ProviderProfile>>;

  /**
   * Translation policies (Appendix A.3). Defaults to `DEFAULT_POLICIES`:
   * reasoning degradation is reported, never silently dropped.
   */
  policies?: TranslationPolicies;

  /**
   * Maximum accepted source request body size in bytes (NFR-006).
   * Requests larger than this are rejected with a validation error.
   * Default: 10 MiB.
   */
  maxBodyBytes?: number;

  /**
   * Optional upstream timeout in milliseconds (NFR-006). When exceeded, the
   * request is aborted and a `timeout` TranslationError is raised. Timeouts
   * compose with the caller's AbortSignal.
   */
  timeoutMs?: number;

  /**
   * Anthropic keepalive ping interval in ms while the upstream is idle
   * (GAP-013). Defaults to 15000; only used when the source protocol is
   * Anthropic Messages.
   */
  keepAliveIntervalMs?: number;

  /**
   * Prompt-cache affinity translation (Anthropic `cache_control` -> OpenAI
   * Chat `prompt_cache_key`). Opt-in; only meaningful when the target is
   * OpenAI Chat. `resolvers` default to `DEFAULT_CACHE_RESOLVERS` (explicit
   * `x-llm-prompt-cache-key` header, then `cache_control` anchors). Injection
   * is gated by the target profile's `capabilities.cache.promptCacheKey`.
   */
  cache?: {
    /** Legacy resolvers that read the raw request/source body. */
    resolvers?: CacheAffinityResolver[];
    /**
     * Privacy-safe resolvers that only read the redacted canonical request.
     * Mounted by `strict` privacy mode (PR-025).
     */
    privacySafeResolvers?: PrivacySafeCacheAffinityResolver[];
    /**
     * Tenant HMAC key for the built-in privacy-safe resolver. When supplied,
     * a redacted-canonical anchor resolver is mounted automatically.
     */
    key?: () => Uint8Array | Promise<Uint8Array>;
    /** Tenant namespace mixed into the HMAC seed. */
    namespace?: string;
  };

  /**
   * Privacy recognition/redaction/restore (docs/04.privacy-transform.md). When
   * set, the same-protocol passthrough fast path is disabled and field-level
   * cache resolvers that read the raw request require explicit authorization.
   */
  privacy?: PrivacyOptions;

  /**
   * Opt-in debug capture of the raw SSE byte streams (PR debug). Disabled by
   * default. Captured data is never written to the trace/report; it is handed
   * to the caller via callbacks and/or `getRawSse()`. The caller is
   * responsible for the sensitivity of captured content.
   */
  debug?: DebugSseOptions;

  /**
   * Privacy completion report, invoked once per request with sanitized
   * statistics only (never raw values or the mapping).
   */
  onPrivacyComplete?: (report: PrivacyCompletionReport) => void;

  /** Diagnostic hook. Must never receive keys, credentials or prompt bodies. */
  trace?: (trace: TranslationTrace) => void;
}

export type ForwardTranslator = ((request: Request) => Promise<Response>) & {
  /** Latest retained raw SSE capture (only when `debug.retain` is enabled). */
  getRawSse?(): DebugSseCapture | undefined;
};

export type DebugSseSide = "upstream" | "client";

/**
 * Debug SSE capture options.
 *
 * - `capture`: which raw SSE stream(s) to capture (default `"upstream-sse"`).
 * - `onChunk`: streaming callback for each captured byte chunk.
 * - `onComplete`: called once per request with the full decoded capture.
 * - `retain`: keep the latest completed capture for `getRawSse()`.
 * - `maxBytes`: retention cap per capture (default 5 MiB); the tap keeps
 *   draining after the cap so the real stream is never blocked.
 */
export interface DebugSseOptions {
  capture?: "upstream-sse" | "client-sse" | "both";
  onChunk?: (chunk: DebugSseChunk) => void;
  onComplete?: (capture: DebugSseCapture) => void;
  retain?: boolean;
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
  /** Request-scoped trace id (NFR-005). */
  traceId: string;
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
