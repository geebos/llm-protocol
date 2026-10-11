/**
 * Unified `translate` entry (05.translate-api.md).
 *
 * `translateCall(from, to, options)` runs one translation:
 * - input  is the source-protocol body/url/headers supplied via `options`;
 * - output is a WHATWG Response in the source protocol: JSON for non-streaming,
 *   live SSE on `Response.body` for streaming (never buffered).
 *
 * Every conversion goes through the Canonical IR and `CanonicalStreamEvent`;
 * the target protocol never leaks to the caller. Streaming uses
 *   target SSE -> SSE frames -> canonical events -> source SSE
 * with backpressure (Web Streams) and cancellation propagation (SR-007/008).
 *
 * Privacy (04.privacy-transform.md) is injected between parse and render:
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
import type { TranslateOptions, TranslationTrace } from "./types.js";
import { CompletionRecorder } from "./completion.js";
import { toUnifiedUsage } from "./usage.js";
import { DebugSseCollector } from "./debug-sse.js";
import {
  createSSEParser,
  createCanonicalValidator,
  withAnthropicKeepAlive,
} from "../streams/index.js";
import type { CanonicalStreamEvent } from "../streams/types.js";
import type { TranslationWarning, Fidelity } from "../ir/fidelity.js";
import { DEFAULT_POLICIES } from "../ir/policies.js";
import {
  resolveCacheAffinity,
  resolvePrivacySafeCacheAffinity,
  DEFAULT_CACHE_RESOLVERS,
} from "../cache/resolver.js";
import type { CacheAffinity } from "../cache/types.js";
import { createAnthropicPrivacySafeCacheResolver } from "../cache/anthropic/privacy-safe-cache.js";
import { applyOpenAIChatCacheAffinity } from "../cache/openai-chat/apply-cache-affinity.js";
import { resolvePrivacyConfig, type ResolvedPrivacyConfig } from "../privacy/config.js";
import { PrivacySession } from "../privacy/session.js";
import { PrivacyGuardError } from "../privacy/errors.js";
import { redactCanonicalRequest, injectSystemNotice } from "../privacy/runtime.js";
import { verifyEgress } from "../privacy/egress.js";
import { verifyExtensions } from "../privacy/extension-verify.js";
import { restoreResponse } from "../privacy/response.js";
import { restoreString } from "../privacy/restore.js";
import { createPrivacyStreamRestore } from "../privacy/stream.js";
import { toTranslationWarning } from "../privacy/config.js";
import type {
  ExtensionPrivacyProof,
  PrivacyCompletionReport,
  PrivacyRequestTrace,
  PrivacyWarning,
} from "../privacy/types.js";

export async function translateCall(
  from: ApiFormat,
  to: ApiFormat,
  options: TranslateOptions,
): Promise<Response> {
  const logid = options.logid ?? crypto.randomUUID();
  const recorder = new CompletionRecorder({
    logid,
    from,
    to,
    onComplete: options.onComplete,
  });
  const startedAt = performance.now();

  // Resolve adapters inside the try so `responses` combinations surface a
  // normalized `unsupported` error and still notify `onComplete` once.
  const execute = options.fetch ?? globalThis.fetch;
  const trace = options.trace;
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs;
  const keepAliveIntervalMs = options.keepAliveIntervalMs ?? 15_000;
  const privacyConfig: ResolvedPrivacyConfig | undefined = options.privacy
    ? resolvePrivacyConfig(options.privacy)
    : undefined;
  const collector = options.debug
    ? new DebugSseCollector(options.debug, logid, startedAt)
    : undefined;

  // ---- request-side state ----
  const ctx: CodecContext = newCodecContext();
  let privacySession: PrivacySession | undefined;
  let allowTexts: string[] = [];
  let extensionProofs: ExtensionPrivacyProof[] = [];
  let privacyRequestTrace: PrivacyRequestTrace | undefined;
  let privacyFinalized = false;
  const reportState: PrivacyReportState | undefined = privacyConfig
    ? {
        sessionId: logid,
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

  const finalizePrivacy = (status: PrivacyCompletionReport["status"]): void => {
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

  const emitTrace = (
    partial: Omit<TranslationTrace, "traceId" | "logid" | "durationMs" | "fidelity">,
  ): void => {
    trace?.({
      traceId: logid,
      logid,
      durationMs: performance.now() - startedAt,
      fidelity: worstFidelity(partial.warnings),
      ...partial,
    });
  };

  try {
    const source = getAdapter(from, options.profiles?.[from], options.policies ?? DEFAULT_POLICIES);
    const target = getAdapter(to, options.profiles?.[to], options.policies ?? DEFAULT_POLICIES);
    const url = parseUrl(options.url);
    const headers = buildHeaders(options.headers);
    const sourcePayload = parseRequestBody(options.body);
    const sourceBytes = new TextEncoder().encode(JSON.stringify(sourcePayload)).byteLength;
    if (sourceBytes > maxBodyBytes) {
      throw validationError(`Request body exceeds the ${maxBodyBytes}-byte limit`);
    }

    const streaming = options.stream ?? source.request.detectStreaming(sourcePayload);
    const upstreamSignal = buildSignal(options.signal, timeoutMs);

    const baseTrace: Omit<
      TranslationTrace,
      "streaming" | "traceId" | "logid" | "durationMs" | "fidelity"
    > = {
      sourceFormat: from,
      targetFormat: to,
      sourceEndpoint: url.pathname,
      targetEndpoint: url.pathname,
      passthrough: false,
      warnings: ctx.warnings,
    };

    // Same-protocol fast path (FR-006, §9.7): no IR parse, no rewrite.
    if (from === to && !privacyConfig) {
      return await runPassthrough({
        url,
        headers,
        sourcePayload,
        streaming,
        signal: upstreamSignal,
        execute,
        recorder,
        collector,
        emitTrace,
        baseTrace,
        finalizePrivacy,
      });
    }

    if (privacyConfig && from === to) {
      pushPrivacyWarning({
        code: "privacy_passthrough_disabled",
        message: "Same-protocol passthrough is disabled while privacy is enabled",
      });
    }

    const canonicalRequest = parseCanonicalRequest(
      source,
      sourcePayload,
      options.model,
      ctx,
    );
    if (options.includeUsage !== undefined) {
      canonicalRequest.includeUsage = options.includeUsage;
    }

    if (privacyConfig && reportState) {
      for (const warning of privacyConfig.warnings) pushPrivacyWarning(warning);
      privacySession = await materializePrivacySession(privacyConfig, logid);
      const outcome = await redactCanonicalRequest(
        canonicalRequest,
        privacyConfig,
        privacySession,
      );
      reportState.redacted = outcome.redacted;
      reportState.invalidDetections = outcome.invalidDetections;
      reportState.degraded = reportState.degraded || outcome.degraded;
      allowTexts = outcome.allowTexts;
      extensionProofs = outcome.extensionProofs;
      privacyRequestTrace = {
        sessionId: logid,
        redacted: outcome.redacted,
        channelsCovered: outcome.channels,
      };
      for (const warning of outcome.warnings) pushPrivacyWarning(warning);
      injectSystemNotice(canonicalRequest, privacyConfig);
    }

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
        cacheAffinity = await resolvePrivacySafeCacheAffinity(safeResolvers, canonicalRequest);
        if (!cacheAffinity && privacyConfig.allowLegacyCacheResolvers) {
          cacheAffinity = await resolveCacheAffinity(
            options.cache?.resolvers ?? DEFAULT_CACHE_RESOLVERS,
            syntheticRequest(url, headers),
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
          syntheticRequest(url, headers),
          sourcePayload,
          canonicalRequest,
        );
      }
    }

    const targetPayload = target.request.renderRequest(canonicalRequest, streaming, ctx);
    const cacheApplication = cacheEnabled
      ? applyOpenAIChatCacheAffinity(targetPayload, cacheAffinity, target.profile, ctx)
      : undefined;
    const outboundPayload = cacheApplication?.body ?? targetPayload;

    if (privacyConfig && privacySession) {
      try {
        verifyExtensions(
          target.request.supportsExtensionReport === true,
          ctx.extensionDispositions,
          extensionProofs,
        );
        verifyEgress(outboundPayload, privacySession, privacyConfig, allowTexts);
      } catch (err) {
        throw normalizePrivacyError(err);
      }
    }

    const outboundText = JSON.stringify(outboundPayload);
    if (privacyRequestTrace) baseTrace.privacy = privacyRequestTrace;
    if (cacheApplication) baseTrace.cache = cacheApplication.report;
    recorder.setRequestBody(outboundPayload);

    const targetRequest = new Request(url, {
      method: "POST",
      headers,
      body: outboundText,
      signal: upstreamSignal,
    });

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
      if (options.signal?.aborted) {
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
    recorder.setResponseMeta(targetResponse.headers, targetResponse.status);

    if (targetResponse.status >= 400) {
      // Upstream rejected before streaming: reverse-translate the error body.
      const errPayload = await readErrorPayload(targetResponse);
      const canonicalError = target.error.parseError(errPayload, targetResponse.status);
      if (privacyConfig && privacySession && privacyConfig.errorRestore === "trusted_client") {
        canonicalError.message = restoreClientErrorText(
          canonicalError.message,
          privacySession,
          privacyConfig,
        );
      }
      const sourcePayloadError = source.error.renderError(canonicalError);
      recorder.setError(canonicalError);
      emitTrace({ ...baseTrace, streaming: false });
      finalizePrivacy("errored");
      recorder.finish("completed");
      return new Response(JSON.stringify(sourcePayloadError), {
        status: mapStatus(targetResponse.status),
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (streaming) {
      return buildStreamingResponse({
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
        collector,
        recorder,
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
    recorder.setUsage(toUnifiedUsage(canonicalResponse.usage));
    // Q2/Q10: source-protocol shape rendered BEFORE privacy restore. Warnings
    // are recorded from this render; the client-facing render uses a scratch
    // context so they are not duplicated.
    recorder.setResponseBody(source.response.renderResponse(canonicalResponse, ctx));
    if (privacyConfig && privacySession && reportState) {
      const counts = restoreResponse(
        canonicalResponse,
        privacySession,
        privacyConfig.template,
        privacyConfig.streaming.maxPlaceholderLength,
        privacyConfig.streaming.maxToolArgumentBytes,
      );
      reportState.restored += counts.restored;
      reportState.unknown += counts.unknown;
      reportState.jsonParseFailures += counts.jsonParseFailures;
      for (const warning of counts.warnings) pushPrivacyWarning(warning);
    }
    const sourcePayloadJson = source.response.renderResponse(
      canonicalResponse,
      newCodecContext(),
    );
    emitTrace({ ...baseTrace, streaming: false });
    finalizePrivacy("completed");
    recorder.finish("completed");
    return new Response(JSON.stringify(sourcePayloadJson), {
      status: mapStatus(targetResponse.status),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const normalized = normalizeError(err);
    recorder.setError(toCanonicalError(normalized));
    const status = normalized.kind === "cancelled" ? "cancelled" : "errored";
    recorder.finish(status);
    finalizePrivacy(status);
    collector?.finalize();
    throw normalized;
  }
}

// ---------------------------------------------------------------------------
// Request-side helpers
// ---------------------------------------------------------------------------

function parseUrl(value: string | URL): URL {
  try {
    return value instanceof URL ? value : new URL(value);
  } catch {
    throw validationError("url must be a valid absolute URL");
  }
}

function buildHeaders(init: HeadersInit | undefined): Headers {
  const headers = new Headers(init);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw validationError("body must be valid JSON");
    }
  }
  if (body && typeof body === "object" && !ArrayBuffer.isView(body)) {
    return body;
  }
  throw validationError("body must be a JSON object or a JSON string");
}

function buildSignal(caller: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
  if (timeoutMs === undefined) return caller ?? new AbortController().signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * Apply `options.model` before parsing when the source body omits it, so a
 * model override works for body shapes that would otherwise fail validation.
 */
function parseCanonicalRequest(
  source: ProtocolAdapter,
  payload: unknown,
  modelOverride: string | undefined,
  ctx: CodecContext,
) {
  let input = payload;
  if (
    modelOverride !== undefined &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { model?: unknown }).model === undefined
  ) {
    input = { ...(payload as Record<string, unknown>), model: modelOverride };
  }
  const canonical = source.request.parseRequest(input, ctx);
  if (modelOverride !== undefined) canonical.model = modelOverride;
  return canonical;
}

async function materializePrivacySession(
  config: ResolvedPrivacyConfig,
  sessionId: string,
): Promise<PrivacySession> {
  const tagKey = config.resolveTagKey ? await config.resolveTagKey() : undefined;
  return new PrivacySession(sessionId, {
    compiled: config.template,
    tagMode: config.tagMode,
    tagBytes: config.tagBytes,
    namespace: config.namespace,
    tagKey,
  });
}

/** Legacy (raw-request) resolvers read headers such as the cache-key header. */
function syntheticRequest(url: URL, headers: Headers): Request {
  return new Request(url, { method: "POST", headers });
}

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

interface PassthroughContext {
  url: URL;
  headers: Headers;
  sourcePayload: unknown;
  streaming: boolean;
  signal: AbortSignal;
  execute: typeof globalThis.fetch;
  recorder: CompletionRecorder;
  collector?: DebugSseCollector;
  emitTrace: (partial: Omit<TranslationTrace, "traceId" | "logid" | "durationMs" | "fidelity">) => void;
  baseTrace: Omit<TranslationTrace, "streaming" | "traceId" | "logid" | "durationMs" | "fidelity">;
  finalizePrivacy: (status: PrivacyCompletionReport["status"]) => void;
}

async function runPassthrough({
  url,
  headers,
  sourcePayload,
  streaming,
  signal,
  execute,
  recorder,
  collector,
  emitTrace,
  baseTrace,
  finalizePrivacy,
}: PassthroughContext): Promise<Response> {
  recorder.setRequestBody(sourcePayload);
  const request = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(sourcePayload),
    signal,
  });
  const response = await execute(request);
  recorder.setResponseMeta(response.headers, response.status);

  // Observe the non-streaming body from a clone BEFORE any debug tee locks the
  // real body stream.
  let observedBody: unknown;
  if (!streaming) {
    try {
      observedBody = await response.clone().json();
    } catch {
      // Non-JSON passthrough bodies are not observable as JSON.
    }
  }

  const rawBody = response.body;
  let outBody: ReadableStream<Uint8Array> | null = rawBody;
  if (collector && rawBody) {
    let body: ReadableStream<Uint8Array> = rawBody;
    if (collector.enabled("upstream")) body = collector.observe(body, "upstream");
    if (collector.enabled("client")) body = collector.observe(body, "client");
    outBody = body;
  }

  emitTrace({ ...baseTrace, streaming, passthrough: true });
  finalizePrivacy("completed");

  if (!streaming && observedBody !== undefined) {
    recorder.setResponseBody(observedBody);
  }
  recorder.finish("completed");

  if (collector && rawBody && outBody) {
    return new Response(outBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface StreamingContext {
  targetResponse: Response;
  source: ProtocolAdapter;
  target: ProtocolAdapter;
  ctx: CodecContext;
  baseTrace: Omit<TranslationTrace, "streaming" | "traceId" | "logid" | "durationMs" | "fidelity">;
  emitTrace: (partial: Omit<TranslationTrace, "traceId" | "logid" | "durationMs" | "fidelity">) => void;
  keepAliveIntervalMs?: number;
  privacyConfig?: ResolvedPrivacyConfig;
  privacySession?: PrivacySession;
  reportState?: PrivacyReportState;
  pushPrivacyWarning?: (warning: PrivacyWarning) => void;
  finalizePrivacy?: (status: PrivacyCompletionReport["status"]) => void;
  collector?: DebugSseCollector;
  recorder: CompletionRecorder;
}

function buildStreamingResponse({
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
  collector,
  recorder,
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
  const rawBody = targetResponse.body;

  let stream: ReadableStream<Uint8Array>;
  let privacyHandle: import("../privacy/stream.js").StreamRestoreHandle | undefined;
  try {
    const upstreamBody = collector ? collector.observe(rawBody, "upstream") : rawBody;
    const parsed = upstreamBody
      .pipeThrough(createSSEParser())
      .pipeThrough(target.stream.createParse(report))
      .pipeThrough(createCanonicalValidator());
    // Q3/Q10: buffer canonical events before privacy restore (placeholder view).
    const observed = parsed.pipeThrough(
      new TransformStream<CanonicalStreamEvent, CanonicalStreamEvent>({
        transform(event, controller) {
          recorder.pushEvent(event);
          if (event.type === "usage") recorder.setUsage(toUnifiedUsage(event.usage));
          controller.enqueue(event);
        },
      }),
    );
    let events: ReadableStream<CanonicalStreamEvent> = observed;
    if (privacyConfig && privacySession && reportState) {
      const handle = createPrivacyStreamRestore(
        privacySession,
        privacyConfig,
        (warning) => {
          pushPrivacyWarning?.(warning);
        },
      );
      privacyHandle = handle;
      events = observed.pipeThrough(handle.stream);
    }
    const rendered = events.pipeThrough(source.stream.createRender(report));
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
        try {
          const { done, value } = await reader!.read();
          if (done) {
            commitStats();
            finalizePrivacy?.("completed");
            recorder.finish("completed");
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          commitStats();
          collector?.finalize();
          finalizePrivacy?.("errored");
          recorder.finish("errored");
          controller.error(err);
        }
      },
      async cancel(reason) {
        privacyHandle?.abort();
        collector?.finalize();
        try {
          await reader?.cancel(reason);
        } catch {
          // upstream cancellation errors are not surfaced to the caller
        }
        finalizePrivacy?.("cancelled");
        recorder.finish("cancelled");
      },
    });
    if (collector?.enabled("client")) {
      stream = collector.observe(stream, "client");
    }
  } catch (err) {
    finalizePrivacy?.("errored");
    recorder.finish("errored");
    collector?.finalize();
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/** Convert a privacy guard error into a sanitized `privacy` TranslationError. */
function normalizePrivacyError(err: unknown): TranslationError {
  if (err instanceof PrivacyGuardError) {
    return new TranslationError({ kind: "privacy", code: err.code, message: err.message });
  }
  return err instanceof TranslationError
    ? err
    : new TranslationError({ kind: "privacy", message: "Privacy transform failed" });
}

function normalizeError(err: unknown): TranslationError {
  if (err instanceof PrivacyGuardError) return normalizePrivacyError(err);
  if (err instanceof TranslationError) return err;
  return new TranslationError({
    kind: "upstream",
    message: err instanceof Error ? err.message : "Translation failed",
  });
}

function toCanonicalError(err: TranslationError) {
  return {
    kind: err.kind,
    message: err.message,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.providerCode !== undefined ? { providerCode: err.providerCode } : {}),
    ...(err.code !== undefined ? { code: err.code } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  };
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

/** Keep target status where it is protocol-meaningful; never fabricate 2xx. */
function mapStatus(status: number): number {
  return status >= 200 && status < 600 ? status : 502;
}
