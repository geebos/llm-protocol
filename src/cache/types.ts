/**
 * Prompt-cache affinity model.
 *
 * Anthropic `cache_control` is not 1:1 representable in OpenAI Chat. This
 * layer extracts a stable cache identity from the *source* request (never by
 * scanning the converted target request) and exposes it as a target-specific
 * `prompt_cache_key`. The key is an affinity hint: whether the target provider
 * actually hits cache is decided by its own prefix hashing.
 *
 * The key (and anchor text / system prompts) must never be logged verbatim;
 * only the report summary (source, anchorCount, injected) is observable.
 */
import type { Fidelity } from "../ir/fidelity.js";

/** A single Anthropic `cache_control` text block that anchors the key. */
export interface CacheAnchor {
  location: "system" | "user" | "assistant";
  /** Trimmed anchor text. */
  text: string;
  cacheControl: { type: "ephemeral"; ttl?: string };
  messageIndex?: number;
  contentIndex?: number;
}

/** Where the cache identity came from. */
export type CacheAffinitySource =
  | "explicit"
  | "anthropic-metadata"
  | "anthropic-cache-control"
  | "conversation-digest"
  | "none";

export interface CacheAffinity {
  /** Stable cache identity to pass to the target protocol. */
  key?: string;
  source: CacheAffinitySource;
  /** Anthropic cache anchors discovered in the source request. */
  anchors?: CacheAnchor[];
  /** Whether this is an approximation rather than lossless semantics. */
  lossy?: boolean;
}

/** Cache-specific fidelity warnings (surfaced through the trace). */
export type CacheTranslationWarningCode =
  | "cache_control_downgraded_to_cache_key"
  | "cache_target_unsupported"
  | "cache_ttl_not_representable"
  | "cache_digest_fallback"
  | "cache_session_metadata_used";

export interface CacheTranslationWarning {
  code: CacheTranslationWarningCode;
  message: string;
  fidelity: Fidelity;
}

/**
 * Structured cache summary safe for observability: never contains the key,
 * anchor text, system prompt or metadata session values.
 */
export interface CacheTranslationReport {
  /** Whether any cache affinity was derived from the source request. */
  detected: boolean;
  /** Where the cache identity came from (only when detected). */
  source?: CacheAffinitySource;
  /** Whether `prompt_cache_key` was injected into the target request. */
  targetKeyInjected: boolean;
  /** Number of cache anchors used to derive the key. */
  anchorCount: number;
  /** True when the mapping is an approximation or could not be applied. */
  degraded: boolean;
  warnings: CacheTranslationWarning[];
}
