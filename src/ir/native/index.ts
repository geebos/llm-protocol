/**
 * Protocol-namespaced Native containers (docs/07.ir-native-codec.md §5.1).
 *
 * Each IR node only carries its own `native` alias, so a `CanonicalTool` can
 * never carry request fields. Protocol and node are isolated.
 */
import type {
  AnthropicNativeChoice,
  AnthropicNativeMessage,
  AnthropicNativePart,
  AnthropicNativeRequest,
  AnthropicNativeResponse,
  AnthropicNativeStream,
  AnthropicNativeTool,
} from "./anthropic.js";
import type {
  ChatNativeChoice,
  ChatNativeMessage,
  ChatNativePart,
  ChatNativeRequest,
  ChatNativeResponse,
  ChatNativeStream,
  ChatNativeTool,
} from "./chat.js";

export type {
  AnthropicNativeChoice,
  AnthropicNativeMessage,
  AnthropicNativePart,
  AnthropicNativeRequest,
  AnthropicNativeResponse,
  AnthropicNativeStream,
  AnthropicNativeTool,
  ChatNativeChoice,
  ChatNativeMessage,
  ChatNativePart,
  ChatNativeRequest,
  ChatNativeResponse,
  ChatNativeStream,
  ChatNativeTool,
};

/** Protocol-keyed container. Every value is a named type, never an unknown blob. */
export interface NativeByFormat<A, C> {
  anthropic?: A;
  chat?: C;
}

export type NativeRequest = NativeByFormat<AnthropicNativeRequest, ChatNativeRequest>;
export type NativeMessage = NativeByFormat<AnthropicNativeMessage, ChatNativeMessage>;
export type NativePart = NativeByFormat<AnthropicNativePart, ChatNativePart>;
export type NativeTool = NativeByFormat<AnthropicNativeTool, ChatNativeTool>;
export type NativeResponse = NativeByFormat<AnthropicNativeResponse, ChatNativeResponse>;
export type NativeChoice = NativeByFormat<AnthropicNativeChoice, ChatNativeChoice>;
export type NativeStream = NativeByFormat<AnthropicNativeStream, ChatNativeStream>;

/** Choice-scoped stream metadata (e.g. Chat per-choice `logprobs` deltas). */
export interface NativeChoiceStreamMetadata {
  logprobs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}
