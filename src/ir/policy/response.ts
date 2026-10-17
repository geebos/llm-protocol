/**
 * Response-side field policies (docs/07.ir-native-codec.md §5.8).
 */
import type { PolicyFor } from "./policy.js";
import type {
  AnthropicNativeChoice,
  AnthropicNativeResponse,
  ChatNativeChoice,
  ChatNativeResponse,
} from "../native/index.js";

export const ANTHROPIC_RESPONSE_POLICY = {
  stopSequence: "required",
  role: "droppable",
  extra: "required",
} satisfies PolicyFor<AnthropicNativeResponse>;

export const ANTHROPIC_CHOICE_POLICY = {
  extra: "required",
} satisfies PolicyFor<AnthropicNativeChoice>;

export const CHAT_RESPONSE_POLICY = {
  created: "droppable",
  systemFingerprint: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativeResponse>;

export const CHAT_CHOICE_POLICY = {
  // logprobs carries response-side token probabilities; no IR home exists yet.
  logprobs: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativeChoice>;
