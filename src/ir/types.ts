/**
 * Canonical content model (Appendix A.1).
 *
 * All cross-protocol conversions go through these types; opaque fields
 * (signature, encryptedContent, providerMetadata) must never be parsed or
 * rewritten by codecs (TH-001).
 */

import type {
  NativeMessage,
  NativePart,
  NativeRequest,
  NativeTool,
} from "./native/index.js";
import type { ApiFormat } from "../formats.js";

export type ImageSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

/** Prompt-cache breakpoint metadata (PR-017): Anthropic `cache_control`. */
export interface CanonicalCacheControl {
  type: "ephemeral";
  ttl?: string;
}

export type ContentPart =
  | {
      type: "text";
      text: string;
      annotations?: unknown[];
      native?: NativePart;
    }
  | { type: "image"; source: ImageSource; native?: NativePart }
  | {
      type: "tool_call";
      id: string;
      name: string;
      argumentsText: string;
      native?: NativePart;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: ContentPart[];
      isError?: boolean;
      native?: NativePart;
    }
  | {
      type: "reasoning";
      summary?: string;
      text?: string;
      signature?: string;
      encryptedContent?: string;
      reasoningId?: string;
      providerMetadata?: unknown;
      native?: NativePart;
    }
  | {
      type: "file";
      /** File payload; this round only the url/base64 forms both protocols express. */
      source: ImageSource;
      filename?: string;
      native?: NativePart;
    }
  | { type: "refusal"; text: string; native?: NativePart }
  | {
      type: "annotation";
      /** Provider annotation kind (e.g. `url_citation`). */
      kind: string;
      text?: string;
      startIndex?: number;
      endIndex?: number;
      url?: string;
      native?: NativePart;
    }
  | {
      type: "opaque_native";
      /** Protocol the raw block came from; it may only round-trip to that protocol. */
      sourceFormat: ApiFormat;
      raw: unknown;
      native?: NativePart;
    };

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface CanonicalMessage {
  role: MessageRole;
  content: ContentPart[];
  native?: NativeMessage;
}

export interface CanonicalTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** OpenAI `strict` flag; not representable in Anthropic (LOSSY on render). */
  strict?: boolean;
  native?: NativeTool;
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

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation?: CanonicalGenerationOptions;
  thinking?: CanonicalThinkingConfig;
  /**
   * Whether the provider may run several tool calls in parallel (OpenAI
   * `parallel_tool_calls`, Anthropic `tool_choice.disable_parallel_tool_use`).
   */
  parallelToolCalls?: boolean;
  /**
   * Best-effort request to include usage in the response
   * (05.translate-api.md §9.4). Rendered natively where the target supports it
   * (OpenAI `stream_options.include_usage`); silently dropped otherwise.
   */
  includeUsage?: boolean;
  /** Protocol-native fields (docs/07). Typed per protocol; never an unknown blob. */
  native?: NativeRequest;
  /** Unrecognized / provider-specific fields, preserved opaque (FR-004). */
  extensions?: Record<string, unknown>;
}
