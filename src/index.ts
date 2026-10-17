/**
 * llm-protocol public API.
 *
 * Phase 1 (M0+M1): canonical IR, Anthropic Messages <-> OpenAI Chat codecs,
 * and the transparent `translate(...)` factory for non-streaming forwarding.
 * SSE streaming (M2) is next.
 */
export { translate, buildTranslateNamespace } from "./pipeline/namespace.js";
export type {
  TranslateOptions,
  TranslateCall,
  TranslateTargets,
  TranslateNamespace,
  TranslateCompletion,
  UnifiedUsage,
  TranslationTrace,
} from "./pipeline/types.js";
export { CompletionRecorder, DEFAULT_MAX_SSE_EVENTS } from "./pipeline/completion.js";
export { toUnifiedUsage } from "./pipeline/usage.js";

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
  CanonicalCacheControl,
  ContentPart,
  ImageSource,
  MessageRole,
} from "./ir/types.js";
export type { CanonicalResponse, CanonicalChoice } from "./ir/response.js";
export type {
  NativeByFormat,
  NativeRequest,
  NativeMessage,
  NativePart,
  NativeTool,
  NativeResponse,
  NativeChoice,
  NativeStream,
  AnthropicNativeRequest,
  AnthropicNativeMessage,
  AnthropicNativePart,
  AnthropicNativeTool,
  AnthropicNativeResponse,
  AnthropicNativeChoice,
  AnthropicNativeStream,
  ChatNativeRequest,
  ChatNativeMessage,
  ChatNativePart,
  ChatNativeTool,
  ChatNativeResponse,
  ChatNativeChoice,
  ChatNativeStream,
  NativeChoiceStreamMetadata,
} from "./ir/native/index.js";
export { getCacheControl } from "./ir/native/accessors.js";
export type {
  DropPolicy,
  FieldPolicy,
  FieldPolicyContext,
  PolicyFor,
} from "./ir/policy/policy.js";
export {
  ANTHROPIC_REQUEST_POLICY,
  ANTHROPIC_MESSAGE_POLICY,
  ANTHROPIC_PART_POLICY,
  ANTHROPIC_TOOL_POLICY,
  CHAT_REQUEST_POLICY,
  CHAT_MESSAGE_POLICY,
  CHAT_PART_POLICY,
  CHAT_TOOL_POLICY,
} from "./ir/policy/request.js";
export {
  ANTHROPIC_RESPONSE_POLICY,
  ANTHROPIC_CHOICE_POLICY,
  CHAT_RESPONSE_POLICY,
  CHAT_CHOICE_POLICY,
} from "./ir/policy/response.js";
export { ANTHROPIC_STREAM_POLICY, CHAT_STREAM_POLICY } from "./ir/policy/stream.js";
export type { ProjectionContext, ProjectionPhase } from "./ir/projection/context.js";
export { projectionContext } from "./ir/projection/context.js";
export type { DropRecord, FeatureAdaptationRecord } from "./ir/projection/drop-record.js";
export { roleProjectionError, fieldProjectionError } from "./ir/projection/role.js";
export { assertToolPairing } from "./ir/projection/tool.js";
export { applyFieldPolicy, type ProjectionSink } from "./ir/projection/apply.js";
export {
  projectAnthropicRequest,
  projectAnthropicTool,
  projectChatRequest,
} from "./ir/projection/native.js";
export type { RoleCapabilities } from "./capabilities/provider-profile.js";
export type { ProjectionOutcome } from "./ir/projection/outcome.js";
export type { PolicyOverride } from "./ir/projection/override.js";
export {
  NON_RELAXABLE_SEGMENTS,
  validateOverride,
  findOverride,
} from "./ir/projection/override.js";
export type {
  DecideFieldInput,
  FieldAdaptationAuthorization,
  FieldDecision,
  ProjectionPlan,
} from "./ir/projection/planner.js";
export {
  ProjectionPlanner,
  decideField,
  executePlan,
  assertPlanStable,
  nonDroppableFieldError,
} from "./ir/projection/planner.js";
export type { TranslationFailurePhase } from "./ir/projection/failure.js";
export { calculateFidelity, worstFidelity } from "./ir/projection/fidelity.js";
export type {
  StreamBlockKey,
  StreamBlockKind,
  StreamLocation,
} from "./ir/stream-key.js";
export { streamBlockKey, streamBlockKeyId, createStreamBlockKey } from "./ir/stream-key.js";
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
export type {
  PrivacySafeCacheAffinityResolver,
  LegacyCacheAffinityResolver,
} from "./cache/resolver.js";
export {
  resolveCacheAffinity,
  resolvePrivacySafeCacheAffinity,
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
  createAnthropicPrivacySafeCacheResolver,
  extractCanonicalCacheAnchors,
  derivePrivacySafeCacheKey,
} from "./cache/anthropic/privacy-safe-cache.js";
export {
  applyOpenAIChatCacheAffinity,
  type CacheApplication,
} from "./cache/openai-chat/apply-cache-affinity.js";

// Privacy transform (docs/04.privacy-transform.md).
export { createPrivacyEngine } from "./privacy/engine.js";
export { restoreString, restoreJsonText } from "./privacy/restore.js";
export { createPrivacyStreamRestore } from "./privacy/stream.js";
export {
  compileTemplate,
  parsePlaceholder,
  renderPlaceholder,
  placeholderTag,
  isValidType,
  scanTemplateShape,
  DEFAULT_TEMPLATE,
  DEFAULT_TAG_BYTES,
  TemplateError,
} from "./privacy/template.js";
export type { CompiledTemplate, ParsedPlaceholder } from "./privacy/template.js";
export { PrivacyGuardError } from "./privacy/errors.js";
export { verifyExtensions } from "./privacy/extension-verify.js";
export { PrivacySession } from "./privacy/session.js";
export { resolvePrivacyConfig } from "./privacy/config.js";
export type { ResolvedPrivacyConfig, SecurityMode } from "./privacy/config.js";
export type {
  Detection,
  RecognizerContext,
  PrivacyRecognizer,
  PrivacyChannel,
  CoverageAction,
  ToolSchemaCoverage,
  PrivacyCoveragePolicy,
  PrivacyMappingOptions,
  PrivacyRecognitionOptions,
  PrivacyStreamingOptions,
  PrivacyOptions,
  MappingEntry,
  PrivacySessionView,
  PrivacySessionOptions,
  PrivacyEngine,
  PrivacyRequestTrace,
  PrivacyCompletionReport,
  PrivacyWarning,
  PrivacyWarningCode,
  RenderedExtensionDisposition,
  ExtensionPrivacyProof,
  PrivacyErrorResult,
} from "./privacy/types.js";
