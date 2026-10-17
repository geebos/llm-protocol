/**
 * OpenAI Chat-native IR fields (docs/07.ir-native-codec.md §5).
 *
 * `refusal` is intentionally absent: it is carried by the public `RefusalPart`
 * to avoid double-writing the same semantic (single source of truth).
 */
export interface ChatNativeRequest {
  /** Original length-field shape (Presence/form preservation). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  streamOptions?: Record<string, unknown>;
  store?: boolean;
  metadata?: Record<string, unknown>;
  user?: string;
  n?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  responseFormat?: Record<string, unknown>;
  serviceTier?: string;
  modalities?: string[];
  audio?: Record<string, unknown>;
  /** Unmapped/future `reasoning_effort` value preserved verbatim. */
  reasoningEffort?: string;
  extra?: Record<string, unknown>;
}

export interface ChatNativeMessage {
  origin?: "messages";
  name?: string;
  /** Legacy assistant `function_call`. */
  functionCall?: { name: string; arguments?: string };
  extra?: Record<string, unknown>;
}

export interface ChatNativePart {
  imageDetail?: "auto" | "low" | "high";
  extra?: Record<string, unknown>;
}

export interface ChatNativeTool {
  strict?: boolean;
  extra?: Record<string, unknown>;
}

export interface ChatNativeResponse {
  created?: number;
  systemFingerprint?: string;
  extra?: Record<string, unknown>;
}

export interface ChatNativeChoice {
  logprobs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ChatNativeStream {
  created?: number;
  systemFingerprint?: string;
  extra?: Record<string, unknown>;
}
