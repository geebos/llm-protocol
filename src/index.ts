/**
 * llm-protocol public API.
 *
 * Phase 1 (M0+M1): canonical IR, Anthropic Messages <-> OpenAI Chat codecs,
 * and the transparent `translate(...)` factory for non-streaming forwarding.
 * SSE streaming (M2) is next.
 */
export { translate } from "./pipeline/translate.js";
export type {
  TranslateOptions,
  ForwardTranslator,
  TranslationTrace,
} from "./pipeline/types.js";

export { API_FORMATS, isApiFormat } from "./formats.js";
export type { ApiFormat } from "./formats.js";

export { TranslationError, validationError, unsupportedError } from "./errors.js";
export type { CanonicalError, ErrorKind } from "./errors.js";

export type {
  CanonicalRequest,
  CanonicalMessage,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalGenerationOptions,
  CanonicalThinkingConfig,
  ContentPart,
  ImageSource,
  MessageRole,
} from "./ir/types.js";
export type { CanonicalResponse } from "./ir/response.js";
export type { CanonicalFinishReason } from "./ir/finish-reason.js";
export type { CanonicalUsage } from "./ir/usage.js";
export type { Fidelity, TranslationWarning } from "./ir/fidelity.js";
export { DEFAULT_POLICIES } from "./ir/policies.js";
export type { TranslationPolicies } from "./ir/policies.js";

export type { ProviderProfile, ProviderCapabilities } from "./capabilities/provider-profile.js";
export type {
  ProtocolAdapter,
  EndpointCodec,
  HeaderCodec,
  RequestCodec,
  ResponseCodec,
  ErrorCodec,
  StreamCodec,
  CodecContext,
} from "./codecs/protocol-adapter.js";

export { createAnthropicAdapter, anthropicDefaultProfile } from "./codecs/anthropic-messages/index.js";
export { createOpenAiChatAdapter, openaiChatDefaultProfile } from "./codecs/openai-chat/index.js";
export type { CanonicalStreamEvent } from "./streams/types.js";
export { createSSEParser, createCanonicalValidator } from "./streams/index.js";

// Prompt-cache affinity (Anthropic cache_control -> OpenAI Chat prompt_cache_key).
export type {
  CacheAffinity,
  CacheAffinitySource,
  CacheAnchor,
  CacheTranslationReport,
  CacheTranslationWarning,
  CacheTranslationWarningCode,
} from "./cache/types.js";
export type { CacheAffinityResolver } from "./cache/resolver.js";
export {
  resolveCacheAffinity,
  composeCacheResolvers,
  explicitCacheKeyResolver,
  DEFAULT_CACHE_RESOLVERS,
} from "./cache/resolver.js";
export {
  anthropicCacheControlResolver,
  extractAnthropicCacheAnchors,
  deriveAnthropicCacheKey,
} from "./cache/anthropic/cache-control.js";
export {
  applyOpenAIChatCacheAffinity,
  type CacheApplication,
} from "./cache/openai-chat/apply-cache-affinity.js";
