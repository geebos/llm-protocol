/**
 * Canonical content model (Appendix A.1).
 *
 * All cross-protocol conversions go through these types; opaque fields
 * (signature, encryptedContent, providerMetadata) must never be parsed or
 * rewritten by codecs (TH-001).
 */

export type ImageSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

/**
 * Discriminated tool-call payload (responses.md v0.5, P0-1).
 *
 * `kind` decides the payload shape only:
 * - `function` -> `argumentsText` is JSON, must `JSON.parse` to an object;
 * - `custom`   -> `inputText` is freeform text, never JSON.parse'd.
 *
 * `namespace`/naming structure is an orthogonal dimension tracked in the Tool
 * Definition Registry (executionKind x nameKind), not part of the payload.
 */
export type CanonicalToolCall =
  | { kind: "function"; id: string; name: string; argumentsText: string }
  | { kind: "custom"; id: string; name: string; inputText: string };

/** One reasoning summary part (responses.md v0.3, P0-3: summary_index space). */
export interface ReasoningSummaryPart {
  text: string;
  summaryIndex?: number;
}

/** One reasoning text part (independent content-part lifecycle). */
export interface ReasoningTextPart {
  text: string;
  contentIndex?: number;
}

export type ContentPart =
  | { type: "text"; text: string; annotations?: unknown[] }
  | { type: "image"; source: ImageSource }
  | { type: "file"; source: ImageSource; filename?: string }
  | ({ type: "tool_call" } & CanonicalToolCall)
  | {
      type: "tool_result";
      toolCallId: string;
      content: ContentPart[];
      isError?: boolean;
    }
  | { type: "refusal"; text: string }
  | {
      type: "reasoning";
      /** Single-value compatibility view (Messages/Chat paths); multi-part uses `summaryParts`. */
      summary?: string;
      /** Single-value compatibility view; multi-part uses `textParts`. */
      text?: string;
      /** Reasoning summary parts (summary_index space, v0.3 P0-3). */
      summaryParts?: ReasoningSummaryPart[];
      /** Reasoning text parts (independent content-part lifecycle). */
      textParts?: ReasoningTextPart[];
      signature?: string;
      encryptedContent?: string;
      reasoningId?: string;
      providerMetadata?: unknown;
    };

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalMessage {
  role: MessageRole;
  content: ContentPart[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** OpenAI `strict` flag; not representable in Anthropic (LOSSY on render). */
  strict?: boolean;
}

export type CanonicalToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export interface CanonicalGenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

export interface CanonicalThinkingConfig {
  /**
   * Thinking mode (v2, P0-6):
   * - `disabled`   -> no thinking (Anthropic `{ type: "disabled" }`)
   * - `enabled`    -> fixed-budget thinking (Anthropic `{ type: "enabled", budget_tokens }`)
   * - `adaptive`   -> adaptive thinking (Anthropic `{ type: "adaptive" }` + `output_config.effort`)
   */
  mode: "disabled" | "enabled" | "adaptive";
  /** Fixed thinking budget for `mode: "enabled"` (Anthropic `budget_tokens`). */
  budgetTokens?: number;
  /** Reasoning effort (OpenAI `reasoning_effort` / Anthropic `output_config.effort`). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Provider display hint, preserved opaque when declared. */
  display?: string;
  /** Provider-specific config, preserved opaque (never parsed by codecs). */
  providerMetadata?: Record<string, unknown>;
}

/**
 * End-user identity (responses.md §3.1.4, v0.4 P1-5/P1-6).
 *
 * `user` (OpenAI deprecated legacy) and `safety_identifier` serve different
 * purposes and must not be merged; both are distinct from cache affinity.
 */
export interface RequestIdentity {
  /** OpenAI `user` (deprecated legacy end-user id). */
  legacyEndUserId?: string;
  /** OpenAI `safety_identifier`: stable end-user id for abuse detection. */
  safetyEndUserId?: string;
}

/** Prompt-cache request settings (responses.md §3.1.4, v0.5 P1-4). */
export interface RequestCache {
  /** OpenAI `prompt_cache_key`: cache affinity key. */
  affinityKey?: string;
  /** OpenAI `prompt_cache_retention`: retention policy (e.g. extended caching). */
  retention?: unknown;
}

/** Output extension selector (responses.md §3.1.2/§10.0, v0.4 P1-8). */
export interface CanonicalOutputIncludes {
  /** Client-preference includes (`include` in the source request). */
  requestedIncludes?: string[];
  /** Translator-required includes (e.g. carrier round-trip needs). */
  translatorRequiredIncludes?: string[];
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: ContentPart[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation?: CanonicalGenerationOptions;
  thinking?: CanonicalThinkingConfig;
  /**
   * Whether the provider may run several tool calls in parallel (OpenAI
   * `parallel_tool_calls`, Anthropic `tool_choice.disable_parallel_tool_use`).
   */
  parallelToolCalls?: boolean;
  /** End-user identity (legacy user / safety_identifier). */
  identity?: RequestIdentity;
  /** Prompt-cache affinity key / retention policy. */
  cache?: RequestCache;
  /** Output extension selector (requested ∪ translator-required). */
  outputIncludes?: CanonicalOutputIncludes;
  /** Unrecognized / provider-specific fields, preserved opaque (FR-004). */
  extensions?: Record<string, unknown>;
}
