/**
 * Pipeline types (9.1, 9.12).
 */
import type { ApiFormat } from "../formats.js";
import type { TranslationWarning, Fidelity } from "../ir/fidelity.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";

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

  /** Diagnostic hook. Must never receive keys, credentials or prompt bodies. */
  trace?: (trace: TranslationTrace) => void;
}

export type ForwardTranslator = (request: Request) => Promise<Response>;

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
}
