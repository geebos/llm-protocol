/**
 * Capability model (FR-007).
 *
 * Mapping decisions are driven by declared capabilities, never by guessing
 * from model names. The default profiles correspond to the official protocol
 * surface; compatible providers may declare narrower or wider capabilities.
 */
import type { ApiFormat } from "../formats.js";

/**
 * Reasoning capability declaration (tech-v2.md §14 / P1-2).
 *
 * Anthropic `thinking.signature` / `signature_delta` is opaque state a model
 * may need to resume thinking next turn; OpenAI Chat has no standard field.
 * Whether the provider can carry it is a declared capability, never guessed
 * from the model name. When not declared, opaque signatures are dropped with
 * a warning instead of being silently lost.
 */
export interface ReasoningCapability {
  /** Provider carries visible reasoning text deltas. */
  text: boolean;
  /** Provider can round-trip an opaque thinking signature across turns. */
  opaqueSignature: boolean;
  /**
   * Source field that carries the opaque signature in Chat responses/streams
   * (e.g. a provider-specific reasoning signature field). Required to emit it.
   */
  signatureField?: string;
}

/**
 * Usage semantics quirks (tech-v2.md §21, GAP-014).
 *
 * Declared provider dialect around token accounting; absence means the
 * standard OpenAI/Anthropic shape is assumed and lossy decisions are warned.
 */
export interface UsageCapabilities {
  /** Provider reports cached input tokens (OpenAI prompt_tokens_details). */
  cacheRead?: boolean;
  /** Provider reports cache write/creation tokens. */
  cacheCreation?: boolean;
  /** Provider may send usage after the finish chunk (late usage). */
  usageAfterFinish?: boolean;
}

/**
 * Streaming dialect quirks (tech-v2.md §21, GAP-014).
 *
 * Provider quirks around SSE framing; absence means standard behavior is
 * assumed. These declarations let the parser tolerate non-standard streams
 * without surfacing spurious warnings.
 */
export interface StreamCapabilities {
  /** Whether the provider ends streams with `data: [DONE]` (default true). */
  doneMarker?: boolean;
  /** Provider may omit the role chunk before content (default false). */
  mayOmitRoleChunk?: boolean;
  /** Provider may split tool id/name/arguments across chunks (default false). */
  maySplitToolMetadata?: boolean;
}

/**
 * Prompt-cache affinity dialect.
 *
 * OpenAI Chat has no standard cache_control; this project approximates it as
 * a stable `prompt_cache_key` (cache affinity, not lossless breakpoint
 * semantics). Whether the target provider accepts that non-standard field is
 * a declared capability — unknown capability is treated as unsupported, so
 * nothing is sent to providers that would 400 on it.
 */
export interface CacheCapabilities {
  /** Provider accepts an OpenAI Chat `prompt_cache_key` request field. */
  promptCacheKey?: boolean;
}

export interface ProviderCapabilities {
  tools: boolean;
  parallelTools: boolean;
  streaming: boolean;
  thinking: boolean;
  /** Provider-specific reasoning field name in Chat responses (TH-003). */
  reasoningField?: string;
  /** Opaque signature handling (P1-2); absent means drop-with-warning. */
  reasoning?: ReasoningCapability;
  /** Usage dialect (GAP-014). */
  usage?: UsageCapabilities;
  /** Streaming dialect (GAP-014). */
  stream?: StreamCapabilities;
  /** Prompt-cache dialect. */
  cache?: CacheCapabilities;
}

export interface ProviderProfile {
  protocol: ApiFormat;
  capabilities: ProviderCapabilities;
  /** Protocol-mandated default headers (e.g. `anthropic-version`). */
  defaultHeaders: Record<string, string>;
}
