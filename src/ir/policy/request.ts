/**
 * Request-side field policies (docs/07.ir-native-codec.md §5.8).
 *
 * `satisfies PolicyFor<T>` enforces compile-time coverage of every native field.
 */
import type { PolicyFor } from "./policy.js";
import type {
  AnthropicNativeMessage,
  AnthropicNativePart,
  AnthropicNativeRequest,
  AnthropicNativeTool,
  ChatNativeMessage,
  ChatNativePart,
  ChatNativeRequest,
  ChatNativeTool,
} from "../native/index.js";

export const ANTHROPIC_REQUEST_POLICY = {
  topK: "droppable",
  metadata: "droppable",
  serviceTier: "droppable",
  outputConfig: "required",
  extra: "required",
} satisfies PolicyFor<AnthropicNativeRequest>;

export const ANTHROPIC_MESSAGE_POLICY = {
  origin: "required",
  extra: "required",
} satisfies PolicyFor<AnthropicNativeMessage>;

export const ANTHROPIC_PART_POLICY = {
  cacheControl: "required",
  thinkingKind: "required",
  extra: "required",
} satisfies PolicyFor<AnthropicNativePart>;

export const ANTHROPIC_TOOL_POLICY = {
  // A server-tool definition has no Chat equivalent: it must not be silently
  // converted into a client-executed function tool (§5.5, docs/03 §15.1).
  type: "required",
  cacheControl: "required",
  extra: "required",
} satisfies PolicyFor<AnthropicNativeTool>;

export const CHAT_REQUEST_POLICY = {
  maxTokensField: "droppable",
  streamOptions: "required",
  store: ({ value }) => (value === true ? "required" : "droppable"),
  metadata: "required",
  user: "droppable",
  // Multi-candidate changes semantics; single candidate (or absent) is safe.
  n: ({ value }) =>
    typeof value === "number" && value > 1 ? "required" : "droppable",
  logprobs: "droppable",
  topLogprobs: "droppable",
  responseFormat: "required",
  serviceTier: "droppable",
  modalities: "required",
  audio: "required",
  reasoningEffort: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativeRequest>;

export const CHAT_MESSAGE_POLICY = {
  origin: "required",
  name: "droppable",
  functionCall: "required",
  extra: "required",
} satisfies PolicyFor<ChatNativeMessage>;

export const CHAT_PART_POLICY = {
  imageDetail: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativePart>;

export const CHAT_TOOL_POLICY = {
  strict: "droppable",
  extra: "required",
} satisfies PolicyFor<ChatNativeTool>;
