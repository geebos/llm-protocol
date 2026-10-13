/**
 * Privacy transform module (docs/04.privacy-transform.md).
 */
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
} from "./types.js";

export {
  compileTemplate,
  parsePlaceholder,
  renderPlaceholder,
  placeholderTag,
  derivedPlaceholderN,
  isValidType,
  scanTemplateShape,
  DEFAULT_TEMPLATE,
  DEFAULT_TAG_BYTES,
  TemplateError,
  type CompiledTemplate,
  type ParsedPlaceholder,
} from "./template.js";
export { PrivacyGuardError, guard } from "./errors.js";
export {
  PrivacySession,
  type SessionConfig,
} from "./session.js";
export {
  resolvePrivacyConfig,
  toTranslationWarning,
  type ResolvedPrivacyConfig,
  type SecurityMode,
} from "./config.js";
export { normalizeCoverage, type NormalizedCoverage } from "./coverage.js";
export {
  createPlaceholderMatcher,
  type PlaceholderMatcher,
  type MatchResult,
} from "./trie.js";
export { restoreText, restoreString, restoreJsonText, type RestoreTextResult } from "./restore.js";
export { collectRequestRegions, type RequestRegions } from "./request.js";
export {
  redactRegions,
  setRegionAction,
  regionText,
  type Region,
  type TextSegment,
  type RedactResult,
} from "./redact.js";
export { restoreResponse, type RestoreCounts } from "./response.js";
export { createPrivacyStreamRestore, type StreamRestoreHandle, type StreamRestoreStats } from "./stream.js";
export { buildSystemNotice, DEFAULT_SYSTEM_NOTICE } from "./system.js";
export { verifyEgress } from "./egress.js";
export {
  verifyExtensions,
  buildExtensionProofs,
} from "./extension-verify.js";
export { createPrivacyEngine } from "./engine.js";
export {
  validateDetection,
  resolveSpans,
  type ValidatedDetection,
} from "./detection.js";
