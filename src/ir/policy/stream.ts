/**
 * Stream-side field policies (docs/07.ir-native-codec.md §5.8).
 */
import type { PolicyFor } from "./policy.js";
import type { AnthropicNativeStream, ChatNativeStream } from "../native/index.js";

export const ANTHROPIC_STREAM_POLICY = {
  messageType: "required",
  extra: "required",
} satisfies PolicyFor<AnthropicNativeStream>;

export const CHAT_STREAM_POLICY = {
  created: "droppable",
  systemFingerprint: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativeStream>;
