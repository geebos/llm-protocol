/**
 * Transparent translation factory (FR-005A/005C/005D, 9.1-9.9).
 *
 * `translate({ from, to })` returns a `Request -> Promise<Response>` handler:
 * - input  is a WHATWG Request in `from` protocol (path, headers, body);
 * - output is a WHATWG Response in `from` protocol: JSON for non-streaming,
 *   live SSE on `Response.body` for streaming (never buffered).
 *
 * The `to` protocol lives entirely inside the factory and never leaks to the
 * caller. Streaming uses the canonical event pipeline
 *   target SSE -> SSE frames -> canonical events -> source SSE
 * with backpressure (Web Streams) and cancellation propagation (SR-007/008).
 *
 * Privacy (docs/privacy-transform.md) is injected between parse and render:
 *   parseRequest -> redactRequest -> systemNotice -> cache -> renderRequest
 *   -> verifyEgress -> execute
 * and reversed on the response path (`restoreResponse` / stream restore).
 */
import { TranslationError, validationError } from "../errors.js";
import type { ApiFormat } from "../formats.js";
import { getAdapter } from "../codecs/registry.js";
import {
  newCodecContext,
  type CodecContext,
  type ProtocolAdapter,
} from "../codecs/protocol-adapter.js";
import type { TranslationTrace, TranslateOptions, ForwardTranslator } from "./types.js";
import { createSSEParser, createCanonicalValidator, withAnthropicKeepAlive } from "../streams/index.js";
import type { TranslationWarning, Fidelity } from "../ir/fidelity.js";
import { DEFAULT_POLICIES } from "../ir/policies.js";
import { resolveCacheAffinity, resolvePrivacySafeCacheAffinity, DEFAULT_CACHE_RESOLVERS } from "../cache/resolver.js";
import type { CacheAffinity } from "../cache/types.js";
import { createAnthropicPrivacySafeCacheResolver } from "../cache/anthropic/privacy-safe-cache.js";
import { applyOpenAIChatCacheAffinity } from "../cache/openai-chat/apply-cache-affinity.js";
import { resolvePrivacyConfig, type ResolvedPrivacyConfig } from "../privacy/config.js";
import { PrivacySession } from "../privacy/session.js";
import { PrivacyGuardError } from "../privacy/errors.js";
import { redactCanonicalRequest, injectSystemNotice } from "../privacy/runtime.js";
import { verifyEgress } from "../privacy/egress.js";
import { verifyExtensions, type ExtensionCoverageEntry } from "../privacy/extension-verify.js";
import { restoreResponse } from "../privacy/response.js";
import { restoreString } from "../privacy/restore.js";
import { createPrivacyStreamRestore } from "../privacy/stream.js";
import { toTranslationWarning } from "../privacy/config.js";
import type {
  PrivacyCompletionReport,
  PrivacyWarning,
} from "../privacy/types.js";

async function readErrorPayload(response: Response): Promise<unknown> {
  // Read once: `response.json()` would consume the body even when it fails,
  // making a later `response.text()` unusable.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { message: "upstream error" };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text || "upstream error" };
  }
}

interface PrivacyReportState {
  sessionId: string;
  redacted: number;
  restored: number;
  unknown: number;
  invalidDetections: number;
  overflowed: boolean;
  jsonParseFailures: number;
  degraded: boolean;
  warnings: PrivacyWarning[];
}

export function translate<
  From extends ApiFormat,
  To extends ApiFormat,
>(options: TranslateOptions<From, To>): ForwardTranslator {
  const source = getAdapter(
    options.from,
    options.profiles?.[options.from],
    options.policies ?? DEFAULT_POLICIES,
  );
  const target = getAdapter(
    options.to,
    options.profiles?.[options.to],
    options.policies ?? DEFAULT_POLICIES,
  );
  const execute = options.fetch ?? globalThis.fetch;
  const trace = options.trace;
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs;
  const keepAliveIntervalMs = options.keepAliveIntervalMs ?? 15_000;
  const privacyConfig: ResolvedPrivacyConfig | undefined = options.privacy
    ? resolvePrivacyConfig(options.privacy)
    : undefined;

  /** Same-protocol fast path: no parse, no rewrite (FR-006, 9.11). */
  if ((options.from as string) === (options.to as string) && !privacyConfig) {
    return async (request: Request): Promise<Response> => {
      const started = performance.now();
      const response = await execute(request);
      trace?.({
        traceId: crypto.randomUUID(),
        sourceFormat: options.from,
        targetFormat: options.to,
        sourceEndpoint: request.url,
        targetEndpoint: request.url,
        streaming: false,
        passthrough: true,
        durationMs: performance.now() - started,
        fidelity: "EXACT",
        warnings: [],
      });
      return response;
    };
  }

  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const traceId = crypto.randomUUID();
    const emitTrace = (partial: Omit<TranslationTrace, "traceId" | "durationMs" | "fidelity">): void => {
      trace?.({
        traceId,
        durationMs: performance.now() - started,
        fidelity: worstFidelity(partial.warnings),
        ...partial,
      });
    };
    if (request.bodyUsed) {
      throw validationError("Request body has already been consumed");
    }
    const ctx: CodecContext = newCodecContext();
    const sourceUrl = new URL(request.url);

    let privacySession: PrivacySession | undefined;
    let allowTexts: string[] = [];
    let extensionsCoverage: ExtensionCoverageEntry[] = [];
    let transformedExtensions: string[] = [];
    let privacyFinalized = false;
    const reportState: PrivacyReportState | undefined = privacyConfig
      ? {
          sessionId: traceId,
          redacted: 0,
          restored: 0,
          unknown: 0,
          invalidDetections: 0,
          overflowed: false,
          jsonParseFailures: 0,
          degraded: false,
          warnings: [],
        }
      : undefined;

    const pushPrivacyWarning = (warning: PrivacyWarning): void => {
      ctx.warnings.push(toTranslationWarning(warning));
      reportState?.warnings.push(warning);
    };

    const finalizePrivacy = (
      status: PrivacyCompletionReport["status"],
    ): void => {
      if (!privacyConfig || !reportState || privacyFinalized || !options.onPrivacyComplete) {
        return;
      }
      privacyFinalized = true;
      options.onPrivacyComplete({
        sessionId: reportState.sessionId,
        redacted: reportState.redacted,
        restored: reportState.restored,
        unknownPlaceholders: reportState.unknown,
        invalidDetections: reportState.invalidDetections,
        overflowed: reportState.overflowed,
        jsonParseFailures: reportState.jsonParseFailures,
        status,
        securityMode: privacyConfig.securityMode,
        degraded: reportState.degraded,
        warnings: reportState.warnings,
      });
    };

    const materializePrivacySession = async (): Promise<PrivacySession> => {
      if (!privacyConfig) throw new Error("privacy is not enabled");
      const tagKey = privacyConfig.resolveTagKey
        ? await privacyConfig.resolveTagKey()
        : undefined;
      return new PrivacySession(traceId, {
        compiled: privacyConfig.template,
        tagMode: privacyConfig.tagMode,
        tagBytes: privacyConfig.tagBytes,
        namespace: privacyConfig.namespace,
        tagKey,
      });
    };

    try {
      if (!source.endpoint.matches(sourceUrl)) {
        throw validationError(
          `URL path "${sourceUrl.pathname}" does not match ${options.from} endpoint`,
        );
      }

      if (privacyConfig && (options.from as string) === (options.to as string)) {
        pushPrivacyWarning({
          code: "privacy_passthrough_disabled",
          message: "Same-protocol passthrough is disabled while privacy is enabled",
        });
      }

      const endpoint = source.endpoint.toCanonical(sourceUrl);
      const bodyBytes = await request.arrayBuffer();
      if (bodyBytes.byteLength > maxBodyBytes) {
        throw validationError(
          `Request body exceeds the ${maxBodyBytes}-byte limit`,
        );
      }
      let sourcePayload: unknown;
      try {
        sourcePayload = JSON.parse(new TextDecoder().decode(bodyBytes));
      } catch {
        throw validationError("Request body must be valid JSON");
      }
      const streaming = source.request.detectStreaming(sourcePayload);
      const canonicalRequest = source.request.parseRequest(sourcePayload, ctx);

      if (privacyConfig && reportState) {
        for (const warning of privacyConfig.warnings) pushPrivacyWarning(warning);
        privacySession = await materializePrivacySession();
        const outcome = await redactCanonicalRequest(
          canonicalRequest,
          privacyConfig,
          privacySession,
        );
        reportState.redacted = outcome.redacted;
        reportState.invalidDetections = outcome.invalidDetections;
        reportState.degraded = reportState.degraded || outcome.degraded;
        allowTexts = outcome.allowTexts;
        extensionsCoverage = outcome.extensionsCoverage;
        transformedExtensions = outcome.transformedExtensions;
        for (const warning of outcome.warnings) pushPrivacyWarning(warning);
        injectSystemNotice(canonicalRequest, privacyConfig);
      }

      // Prompt-cache affinity (Anthropic cache_control -> OpenAI Chat
      // prompt_cache_key). Without privacy, derive from the raw source body.
      // With privacy, only privacy-safe resolvers (redacted canonical) run by
      // default; legacy request-reading resolvers require explicit opt-in
      // (PR-021/PR-025). The privacy-safe identity is an HMAC digest, so the
      // outbound key never exposes an enumerable hash of raw anchors.
      const cacheEnabled = options.cache !== undefined && target.format === "openai-chat";
      let cacheAffinity: CacheAffinity | undefined;
      if (cacheEnabled) {
        if (privacyConfig) {
          const safeResolvers = [
            ...(options.cache?.privacySafeResolvers ?? []),
            ...(options.cache?.key
              ? [
                  createAnthropicPrivacySafeCacheResolver({
                    key: options.cache.key,
                    namespace: options.cache.namespace ?? "",
                  }),
                ]
              : []),
          ];
          cacheAffinity = await resolvePrivacySafeCacheAffinity(
            safeResolvers,
            canonicalRequest,
          );
          if (!cacheAffinity && privacyConfig.allowLegacyCacheResolvers) {
            cacheAffinity = await resolveCacheAffinity(
              options.cache?.resolvers ?? DEFAULT_CACHE_RESOLVERS,
              request,
              sourcePayload,
              canonicalRequest,
            );
          } else if (!cacheAffinity && safeResolvers.length === 0) {
            pushPrivacyWarning({
              code: "privacy_untrusted_cache_resolver",
              message:
                "Cache affinity legacy resolvers are disabled under privacy unless explicitly authorized",
            });
          }
        } else {
          cacheAffinity = await resolveCacheAffinity(
            options.cache?.resolvers ?? DEFAULT_CACHE_RESOLVERS,
            request,
            sourcePayload,
            canonicalRequest,
          );
        }
      }

      const targetUrl = target.endpoint.fromCanonical(endpoint, sourceUrl);
      const credential = source.headers.parseCredential(request.headers);
      const targetHeaders = target.headers.renderTargetHeaders(
        request.headers,
        credential,
      );
      const targetPayload = target.request.renderRequest(
        canonicalRequest,
        streaming,
        ctx,
      );
      const cacheApplication = cacheEnabled
        ? applyOpenAIChatCacheAffinity(
            targetPayload,
            cacheAffinity,
            target.profile,
            ctx,
          )
        : undefined;
      const outboundPayload = cacheApplication?.body ?? targetPayload;

      if (privacyConfig && privacySession) {
        try {
          verifyExtensions(
            target.request.supportsExtensionReport === true,
            ctx.extensionDispositions,
            extensionsCoverage,
            transformedExtensions,
          );
          verifyEgress(outboundPayload, privacySession, privacyConfig, allowTexts);
        } catch (err) {
          throw normalizePrivacyError(err);
        }
      }

      const upstreamSignal =
        timeoutMs !== undefined
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
          : request.signal;

      const targetRequest = new Request(targetUrl, {
        method: request.method,
        headers: targetHeaders,
        body: JSON.stringify(outboundPayload),
        signal: upstreamSignal,
      });

      const baseTrace: Omit<
        TranslationTrace,
        "streaming" | "traceId" | "durationMs" | "fidelity"
      > = {
        sourceFormat: options.from,
        targetFormat: options.to,
        sourceEndpoint: sourceUrl.pathname,
        targetEndpoint: targetUrl.pathname,
        passthrough: false,
        warnings: ctx.warnings,
        ...(cacheApplication ? { cache: cacheApplication.report } : {}),
      };

      let targetResponse: Response;
      try {
        targetResponse = await execute(targetRequest);
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new TranslationError({
            kind: "timeout",
            message: `Upstream request timed out after ${timeoutMs}ms`,
            cause: err,
          });
        }
        if (request.signal?.aborted) {
          throw new TranslationError({
            kind: "cancelled",
            message: "Translation cancelled by caller",
            cause: err,
          });
        }
        throw new TranslationError({
          kind: "upstream",
          message: "Upstream fetch failed",
          cause: err,
        });
      }

      if (targetResponse.status >= 400) {
        // Upstream rejected before streaming: reverse-translate the error body.
        const errPayload = await readErrorPayload(targetResponse);
        const canonicalError = target.error.parseError(
          errPayload,
          targetResponse.status,
        );
        if (
          privacyConfig &&
          privacySession &&
          privacyConfig.errorRestore === "trusted_client"
        ) {
          canonicalError.message = restoreClientErrorText(
            canonicalError.message,
            privacySession,
            privacyConfig,
          );
        }
        const sourcePayloadError = source.error.renderError(canonicalError);
        emitTrace({ ...baseTrace, streaming: false });
        finalizePrivacy("errored");
        return new Response(JSON.stringify(sourcePayloadError), {
          status: mapStatus(targetResponse.status),
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (streaming) {
        return translateStreamingResponse({
          targetResponse,
          source,
          target,
          ctx,
          baseTrace,
          emitTrace,
          keepAliveIntervalMs,
          privacyConfig,
          privacySession,
          reportState,
          pushPrivacyWarning,
          finalizePrivacy,
        });
      }

      let targetPayloadJson: unknown;
      try {
        targetPayloadJson = await targetResponse.json();
      } catch {
        throw new TranslationError({
          kind: "upstream",
          message: "Upstream returned a non-JSON body for a non-streaming request",
          status: targetResponse.status,
        });
      }
      const canonicalResponse = target.response.parseResponse(targetPayloadJson, ctx);
      if (privacyConfig && privacySession && reportState) {
        const counts = restoreResponse(
          canonicalResponse,
          privacySession,
          privacyConfig.template,
          privacyConfig.streaming.maxPlaceholderLength,
        );
        reportState.restored += counts.restored;
        reportState.unknown += counts.unknown;
        reportState.jsonParseFailures += counts.jsonParseFailures;
        for (const warning of counts.warnings) pushPrivacyWarning(warning);
      }
      const sourcePayloadJson = source.response.renderResponse(canonicalResponse, ctx);
      emitTrace({ ...baseTrace, streaming: false });
      finalizePrivacy("completed");
      return new Response(JSON.stringify(sourcePayloadJson), {
        status: mapStatus(targetResponse.status),
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      finalizePrivacy("errored");
      throw err instanceof PrivacyGuardError ? normalizePrivacyError(err) : err;
    }
  };
}

/** Convert a privacy guard error into a sanitized `privacy` TranslationError. */
function normalizePrivacyError(err: unknown): TranslationError {
  if (err instanceof PrivacyGuardError) {
    return new TranslationError({ kind: "privacy", code: err.code, message: err.message });
  }
  return err instanceof TranslationError
    ? err
    : new TranslationError({ kind: "privacy", message: "Privacy transform failed" });
}

function restoreClientErrorText(
  message: string,
  session: PrivacySession,
  config: ResolvedPrivacyConfig,
): string {
  // Only the client-visible message is restored; internal diagnostics never are.
  return restoreString(
    message,
    config.template,
    session.snapshot(),
    config.streaming.maxPlaceholderLength,
  ).text;
}

/** Worst fidelity across warnings (EXACT if none). */
function worstFidelity(warnings: TranslationWarning[]): Fidelity {
  let worst: Fidelity = "EXACT";
  for (const w of warnings) {
    if (w.fidelity === "UNSUPPORTED") return "UNSUPPORTED";
    if (w.fidelity === "LOSSY" && worst === "EXACT") worst = "LOSSY";
    else if (w.fidelity === "COMPATIBLE" && worst === "EXACT") worst = "COMPATIBLE";
  }
  return worst;
}

interface StreamingContext {
  targetResponse: Response;
  source: ProtocolAdapter;
  target: ProtocolAdapter;
  ctx: CodecContext;
  baseTrace: Omit<TranslationTrace, "streaming" | "traceId" | "durationMs" | "fidelity">;
  emitTrace: (partial: Omit<TranslationTrace, "traceId" | "durationMs" | "fidelity">) => void;
  keepAliveIntervalMs?: number;
  privacyConfig?: ResolvedPrivacyConfig;
  privacySession?: PrivacySession;
  reportState?: PrivacyReportState;
  pushPrivacyWarning?: (warning: PrivacyWarning) => void;
  finalizePrivacy?: (status: PrivacyCompletionReport["status"]) => void;
}

/**
 * Streaming path (9.7, 9.9): pipe the upstream SSE body through
 * target-parse -> canonical validate -> [privacy restore] -> source-render
 * without buffering. Cancellation propagates through the Web Streams pipe.
 */
function translateStreamingResponse({
  targetResponse,
  source,
  target,
  ctx,
  baseTrace,
  emitTrace,
  keepAliveIntervalMs,
  privacyConfig,
  privacySession,
  reportState,
  pushPrivacyWarning,
  finalizePrivacy,
}: StreamingContext): Response {
  if (!targetResponse.body) {
    throw new TranslationError({
      kind: "stream_protocol",
      message: "Upstream returned an empty body for a streaming request",
      status: targetResponse.status,
    });
  }

  const report = (warning: TranslationWarning): void => {
    ctx.warnings.push(warning);
  };

  let stream: ReadableStream<Uint8Array>;
  let privacyHandle: import("../privacy/stream.js").StreamRestoreHandle | undefined;
  try {
    let events: ReadableStream<import("../streams/types.js").CanonicalStreamEvent> | undefined;
    const parsed = targetResponse.body
      .pipeThrough(createSSEParser())
      .pipeThrough(target.stream.createParse(report))
      .pipeThrough(createCanonicalValidator());
    if (privacyConfig && privacySession && reportState) {
      const handle = createPrivacyStreamRestore(
        privacySession,
        privacyConfig,
        (warning) => {
          pushPrivacyWarning?.(warning);
        },
      );
      privacyHandle = handle;
      events = parsed.pipeThrough(handle.stream);
    } else {
      events = parsed;
    }
    let rendered = events.pipeThrough(source.stream.createRender(report));
    const clientStream =
      source.format === "anthropic-messages"
        ? withAnthropicKeepAlive(rendered, keepAliveIntervalMs)
        : rendered;
    const commitStats = (): void => {
      if (privacyHandle && reportState) {
        reportState.restored += privacyHandle.stats.restored;
        reportState.unknown += privacyHandle.stats.unknown;
        reportState.overflowed = reportState.overflowed || privacyHandle.stats.overflowed;
        reportState.jsonParseFailures += privacyHandle.stats.jsonParseFailures;
      }
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    stream = new ReadableStream<Uint8Array>({
      start() {
        reader = clientStream.getReader();
      },
      async pull(controller) {
        const { done, value } = await reader!.read();
        if (done) {
          commitStats();
          finalizePrivacy?.("completed");
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      async cancel(reason) {
        privacyHandle?.abort();
        try {
          await reader?.cancel(reason);
        } catch {
          // upstream cancellation errors are not surfaced to the caller
        }
        finalizePrivacy?.("cancelled");
      },
    });
  } catch (err) {
    finalizePrivacy?.("errored");
    throw err;
  }

  emitTrace({ ...baseTrace, streaming: true });
  return new Response(stream, {
    status: mapStatus(targetResponse.status),
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

/** Keep target status where it is protocol-meaningful; never fabricate 2xx. */
function mapStatus(status: number): number {
  return status >= 200 && status < 600 ? status : 502;
}
