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

/**
 * Thinking generation capabilities (responses.md §11.1, v0.3 P1-8).
 *
 * Decides how `reasoning.effort` / budget maps onto the target. Never guess
 * model generations from names: the profile declares the dialect.
 */
export interface ThinkingGenerationCapabilities {
  /** Thinking modes the model supports. */
  mode: "none" | "manual" | "adaptive";
  /** Where effort lives: adaptive models use `output_config`; legacy manual has none. */
  effortLocation?: "output_config" | "none";
  /** Whether manual `budget_tokens` is still supported (false = deprecated/400). */
  manualBudgetSupported: boolean;
  /** Whether thinking interleaves with tool calls. */
  interleaving: boolean;
  /** Whether the thinking block must lead the message. */
  requiresLeadingBlock: boolean;
}

/**
 * Responses-specific capabilities (responses.md §3.1.3 / §15, D-4).
 *
 * Stateful Responses fields are gated per capability instead of rejected
 * wholesale; identity fields are separate from cache affinity.
 */
export interface ResponsesCapabilities {
  /** `previous_response_id` / `conversation` server-side state support. */
  conversationState?: boolean;
  /** `store` support (true = server stores the response). */
  responseStorage?: boolean;
  /** `prompt` template reference support. */
  promptTemplates?: boolean;
  /** Custom/freeform tools (inputText, no JSON.parse). */
  customTools?: boolean;
  /** Namespaced tool names (flatten + reversible map). */
  namespaceTools?: boolean;
  /** `text.format` structured output support. */
  structuredOutput?: boolean;
  /** Provider can carry reasoning text (not just summary). */
  reasoningText?: boolean;
  /** Reasoning carrier mode: native fields only, or managed round-trip carrier. */
  carrierMode?: "native" | "managed";
  /** Which non-terminal/terminal SSE lifecycle events exist. */
  terminalEvents?: { queued?: boolean; cancelled?: boolean };
  /** Non-standard Responses request extensions accepted by the provider. */
  responsesExtensions?: { stop?: boolean };
  /** `truncation=auto` support (item-aware truncation). */
  contextTruncation?: { auto?: boolean };
  /** End-user tracking field support (legacy `user` / `safety_identifier`). */
  identity?: { endUserTracking?: { legacy?: boolean; safety?: boolean } };
  /** v1 boundary: only client-executed function/custom tools are canonicalized. */
  serverSideTools?: boolean;
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
  /** Thinking generation dialect (responses.md §11.1). */
  thinkingGeneration?: ThinkingGenerationCapabilities;
  /** Responses-specific capability bits (responses.md, D-4). */
  responses?: ResponsesCapabilities;
}

export interface ProviderProfile {
  protocol: ApiFormat;
  capabilities: ProviderCapabilities;
  /** Protocol-mandated default headers (e.g. `anthropic-version`). */
  defaultHeaders: Record<string, string>;
}
