/**
 * Privacy configuration compilation (§5.2, §10.3).
 *
 * Options are validated once at factory time: recognizer priorities must be
 * finite and unique, the placeholder template must be unambiguous and the
 * streaming thresholds must be sane. `strict` mode ignores configured
 * downgrades (they only apply to `best_effort`) and records a warning.
 */
import { validationError } from "../errors.js";
import type { TranslationWarning } from "../ir/fidelity.js";
import { compileTemplate, DEFAULT_TAG_BYTES, DEFAULT_TEMPLATE, TemplateError, type CompiledTemplate } from "./template.js";
import type {
  PrivacyCoveragePolicy,
  PrivacyOptions,
  PrivacyRecognizer,
  PrivacyWarning,
} from "./types.js";
import { normalizeCoverage, type NormalizedCoverage } from "./coverage.js";

export type SecurityMode = "strict" | "best_effort";

export interface ResolvedRecognition {
  onRecognizerError: "reject" | "passthrough_with_warning";
  onInvalidDetection: "reject" | "drop_with_warning";
}

export interface ResolvedStreaming {
  maxTextPendingBytes: number;
  maxToolArgumentBytes: number;
  maxPlaceholderLength: number;
  maxTypeLength: number;
  overflowAction: "reject" | "flush_raw";
  strictStreaming: boolean;
}

export interface ResolvedPrivacyConfig {
  recognizers: PrivacyRecognizer[];
  coverage: NormalizedCoverage;
  template: CompiledTemplate;
  tagMode: boolean;
  tagBytes: number;
  namespace: string;
  resolveTagKey?: () => Uint8Array | Promise<Uint8Array>;
  system: string | false;
  errorRestore: "never" | "trusted_client";
  securityMode: SecurityMode;
  egress: "policy" | "strict";
  minEgressValueLength: number;
  allowLegacyCacheResolvers: boolean;
  recognition: ResolvedRecognition;
  streaming: ResolvedStreaming;
  /** Config-time warnings (already sanitized). */
  warnings: PrivacyWarning[];
}

const DEFAULT_STREAMING: ResolvedStreaming = {
  maxTextPendingBytes: 4096,
  maxToolArgumentBytes: 1024 * 1024,
  maxPlaceholderLength: 128,
  maxTypeLength: 32,
  overflowAction: "reject",
  strictStreaming: false,
};

function validateRecognizers(recognizers: PrivacyRecognizer[]): void {
  if (!Array.isArray(recognizers) || recognizers.length === 0) {
    throw validationError("privacy.recognizers must be a non-empty array");
  }
  const seen = new Set<number>();
  for (const r of recognizers) {
    if (typeof r?.recognize !== "function") {
      throw validationError("privacy recognizer must implement recognize()");
    }
    const p = r.priority;
    if (typeof p !== "number" || !Number.isFinite(p)) {
      throw validationError("privacy recognizer priority must be a finite number");
    }
    if (seen.has(p)) {
      throw validationError("privacy recognizer priorities must be unique");
    }
    seen.add(p);
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function resolvePrivacyConfig(options: PrivacyOptions): ResolvedPrivacyConfig {
  validateRecognizers(options.recognizers);
  const securityMode: SecurityMode = options.securityMode ?? "strict";
  const warnings: PrivacyWarning[] = [];

  let template: CompiledTemplate;
  try {
    template = compileTemplate(options.mapping?.template ?? DEFAULT_TEMPLATE, {
      tagMode: options.mapping?.tagMode ?? false,
      tagBytes: options.mapping?.tagBytes ?? DEFAULT_TAG_BYTES,
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      throw validationError(`Invalid privacy placeholder template: ${err.code}`);
    }
    throw err;
  }
  if (template.tagMode && (!options.tagKey || !options.tagNamespace)) {
    throw validationError("tagMode requires both tagKey and tagNamespace");
  }

  const recognition: ResolvedRecognition = {
    onRecognizerError: options.recognition?.onRecognizerError ?? "reject",
    onInvalidDetection: options.recognition?.onInvalidDetection ?? "reject",
  };
  const streaming: ResolvedStreaming = {
    maxTextPendingBytes: positiveInt(options.streaming?.maxTextPendingBytes, DEFAULT_STREAMING.maxTextPendingBytes),
    maxToolArgumentBytes: positiveInt(options.streaming?.maxToolArgumentBytes, DEFAULT_STREAMING.maxToolArgumentBytes),
    maxPlaceholderLength: positiveInt(options.streaming?.maxPlaceholderLength, DEFAULT_STREAMING.maxPlaceholderLength),
    maxTypeLength: positiveInt(options.streaming?.maxTypeLength, DEFAULT_STREAMING.maxTypeLength),
    overflowAction: options.streaming?.overflowAction ?? DEFAULT_STREAMING.overflowAction,
    strictStreaming: options.streaming?.strictStreaming ?? DEFAULT_STREAMING.strictStreaming,
  };

  if (securityMode === "strict") {
    if (recognition.onRecognizerError !== "reject") {
      warnings.push(degradedIgnored("recognition.onRecognizerError"));
    }
    if (recognition.onInvalidDetection !== "reject") {
      warnings.push(degradedIgnored("recognition.onInvalidDetection"));
    }
    if (streaming.overflowAction !== "reject") {
      warnings.push(degradedIgnored("streaming.overflowAction"));
    }
    recognition.onRecognizerError = "reject";
    recognition.onInvalidDetection = "reject";
    streaming.overflowAction = "reject";
  }

  const coverageInput: PrivacyCoveragePolicy = options.coverage ?? {};
  return {
    recognizers: options.recognizers,
    coverage: normalizeCoverage(coverageInput),
    template,
    tagMode: template.tagMode,
    tagBytes: template.tagBytes,
    namespace: options.tagNamespace ?? "",
    resolveTagKey: options.tagKey,
    system: options.system ?? "default",
    errorRestore: options.errorRestore ?? "never",
    securityMode,
    egress: options.egress ?? "policy",
    minEgressValueLength: positiveInt(options.minEgressValueLength, 1),
    allowLegacyCacheResolvers: options.allowLegacyCacheResolvers ?? false,
    recognition,
    streaming,
    warnings,
  };
}

function degradedIgnored(field: string): PrivacyWarning {
  return {
    code: "privacy_degraded_mode",
    message: `strict privacy mode ignores configured downgrade for ${field}`,
    field,
  };
}

/** Bridge privacy warnings into the translation warning channel. */
export function toTranslationWarning(w: PrivacyWarning): TranslationWarning {
  return { code: w.code, message: w.message, fidelity: "LOSSY", field: w.field };
}
