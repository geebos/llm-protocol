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

export type ContentPart =
  | { type: "text"; text: string; annotations?: unknown[] }
  | { type: "image"; source: ImageSource }
  | {
      type: "tool_call";
      id: string;
      name: string;
      argumentsText: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: ContentPart[];
      isError?: boolean;
    }
  | {
      type: "reasoning";
      summary?: string;
      text?: string;
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
  enabled: boolean;
  budgetTokens?: number;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: ContentPart[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation?: CanonicalGenerationOptions;
  thinking?: CanonicalThinkingConfig;
  /** Unrecognized / provider-specific fields, preserved opaque (FR-004). */
  extensions?: Record<string, unknown>;
}
