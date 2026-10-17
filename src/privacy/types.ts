/**
 * Privacy transform public model (docs/04.privacy-transform.md, PR-001..PR-025).
 *
 * Recognition is supplied by the caller; this layer owns span resolution,
 * deterministic placeholder allocation, replacement and restoration. Raw
 * privacy values and the placeholder mapping are sensitive and must never
 * reach traces, reports, logs or error messages (INV-3).
 */

/** A caller-supplied detection over UTF-16 code units. `value` is verification-only. */
export interface Detection {
  start: number;
  end: number;
  type: string;
  value?: string;
  confidence?: number;
  metadata?: unknown;
}

/** Text channel a recognizer is invoked for. */
export type PrivacyChannel =
  | "system"
  | "message_text"
  | "tool_result"
  | "tool_arguments"
  | "tool_description"
  | "tool_schema"
  | "reasoning"
  | "extensions"
  | "native"
  | "text";

export interface RecognizerContext {
  channel: PrivacyChannel;
  path?: string;
  sessionId: string;
}

export interface PrivacyRecognizer {
  /** Required and unique within the recognizer list (PR-001). */
  priority: number;
  recognize(
    text: string,
    context: RecognizerContext,
  ): Detection[] | Promise<Detection[]>;
}

export type CoverageAction = "redact" | "allow" | "reject";

export interface ToolSchemaCoverage {
  structural?: CoverageAction;
  text?: CoverageAction;
  valueBearing?: CoverageAction;
}

export interface PrivacyCoveragePolicy {
  system?: CoverageAction;
  message_text?: CoverageAction;
  tool_result?: CoverageAction;
  tool_arguments?: CoverageAction;
  tool_description?: CoverageAction;
  tool_schema?: CoverageAction | ToolSchemaCoverage;
  reasoning?: CoverageAction;
  extensions?: CoverageAction | Record<string, CoverageAction>;
  /**
   * Native protocol partitions (docs/07 §8.2.4). Keys are `<proto>.<field>`
   * (e.g. `anthropic.metadata`). Default `allow`, like extensions (INV-10).
   */
  native?: CoverageAction | Record<string, CoverageAction>;
}

export interface PrivacyMappingOptions {
  /** Default `<private_placeholder_{type}_{N}>`. Must be unambiguous. */
  template?: string;
  /** Include a versioned HMAC tag in the placeholder (default false). */
  tagMode?: boolean;
  /** HMAC tag length in bytes; must be >= 12 (>=96-bit). Default 12. */
  tagBytes?: number;
  /**
   * Placeholder identifier mode. `sequence` (default) numbers tokens in IR
   * document order; `derived` derives the number from an HMAC so the same
   * (context, type, value) is stable across requests. `derived` requires
   * `tagKey` and `tagContextId` (docs/06 §10.2).
   */
  idMode?: "sequence" | "derived";
  /** Stable context id for `idMode: "derived"`; must not vary per request. */
  tagContextId?: string;
  /**
   * Reversible escaping of external literal text (docs/06). Default true.
   * When disabled the legacy fail-closed collision behaviour is restored.
   */
  escape?: boolean;
}

export interface PrivacyRecognitionOptions {
  onRecognizerError?: "reject" | "passthrough_with_warning";
  onInvalidDetection?: "reject" | "drop_with_warning";
}

export interface PrivacyStreamingOptions {
  maxTextPendingBytes?: number;
  maxToolArgumentBytes?: number;
  maxPlaceholderLength?: number;
  maxTypeLength?: number;
  overflowAction?: "reject" | "flush_raw";
  strictStreaming?: boolean;
}

export interface PrivacyOptions {
  recognizers: PrivacyRecognizer[];
  coverage?: PrivacyCoveragePolicy;
  mapping?: PrivacyMappingOptions;
  recognition?: PrivacyRecognitionOptions;
  streaming?: PrivacyStreamingOptions;
  tagKey?: () => Uint8Array | Promise<Uint8Array>;
  tagNamespace?: string;
  system?: string | false;
  errorRestore?: "never" | "trusted_client";
  /** `strict` guarantees no leakage; `best_effort` allows configured downgrades. */
  securityMode?: "strict" | "best_effort";
  /** EgressVerify posture; `policy` honours allow, `strict` overrides it. */
  egress?: "policy" | "strict";
  minEgressValueLength?: number;
  allowLegacyCacheResolvers?: boolean;
}

/** Read-only session mapping entry (PR-004). */
export interface MappingEntry {
  readonly id: string;
  readonly type: string;
  readonly original: string;
  readonly placeholder: string;
  readonly createdAt: number;
}

/** Read-only session view handed to callers. */
export interface PrivacySessionView {
  readonly id: string;
  readonly version: number;
  readonly activeStreams: number;
  lookupPlaceholder(placeholder: string): MappingEntry | undefined;
  lookupOriginal(type: string, original: string): MappingEntry | undefined;
  /** Snapshot of every mapping entry (placeholder -> entry). */
  entries(): MappingEntry[];
}

export interface PrivacySessionOptions {
  template?: string;
  tagMode?: boolean;
  tagBytes?: number;
}

export interface PrivacyEngine {
  createSession(id?: string, options?: PrivacySessionOptions): PrivacySessionView;
  getSession(id: string): PrivacySessionView | undefined;
  destroySession(id: string): void;
  redact(
    text: string,
    session: PrivacySessionView,
    recognizers: PrivacyRecognizer[],
    context?: Partial<RecognizerContext>,
  ): Promise<string>;
  restore(text: string, session: PrivacySessionView): string;
}

export interface PrivacyRequestTrace {
  sessionId: string;
  redacted: number;
  channelsCovered: PrivacyChannel[];
}

export interface PrivacyCompletionReport {
  sessionId: string;
  redacted: number;
  /** Literal shapes prefix-escaped during the request (docs/06 Appendix B). */
  escaped: number;
  restored: number;
  unknownPlaceholders: number;
  invalidDetections: number;
  overflowed: boolean;
  jsonParseFailures: number;
  status: "completed" | "errored" | "cancelled" | "aborted";
  securityMode: "strict" | "best_effort";
  degraded: boolean;
  warnings: PrivacyWarning[];
}

export type PrivacyWarningCode =
  | "privacy_recognizer_failed"
  | "privacy_invalid_detection"
  | "privacy_buffer_overflow"
  | "privacy_unknown_placeholder"
  | "privacy_channel_skipped"
  | "privacy_signature_guard"
  | "privacy_uncovered_channel"
  | "privacy_json_parse_failed"
  | "privacy_json_key_placeholder"
  | "privacy_cache_control_dropped"
  | "privacy_extension_unverifiable"
  | "privacy_cross_part_detection_unsafe"
  | "privacy_cross_part_cache_break"
  | "privacy_untrusted_cache_resolver"
  | "privacy_placeholder_collision"
  | "privacy_field_unescapable"
  | "privacy_degraded_mode";

/** Sanitized privacy warning: never carries raw values, mappings or user text. */
export interface PrivacyWarning {
  code: PrivacyWarningCode;
  message: string;
  /** Structural field path (never a value). */
  field?: string;
}

/** Codec render evidence: which extension fields were forwarded. */
export interface RenderedExtensionDisposition {
  path: string;
  kind: "text" | "non-text" | "opaque";
  forwarded: boolean;
  fieldId: string;
}

/** Privacy evidence: how an extension field was handled. */
export interface ExtensionPrivacyProof {
  path: string;
  status: "inspected" | "transformed" | "rejected";
  fieldId: string;
}

/** Client-visible error surface (PR-013): diagnostic text is always isolated. */
export interface PrivacyErrorResult {
  clientMessage: string;
  diagnosticCode: string;
  requestId: string;
}
