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
import { resolveCacheAffinity, DEFAULT_CACHE_RESOLVERS } from "../cache/resolver.js";
import { applyOpenAIChatCacheAffinity } from "../cache/openai-chat/apply-cache-affinity.js";

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    const text = await response.text();
    return { message: text || "upstream error" };
  }
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

  /** Same-protocol fast path: no parse, no rewrite (FR-006, 9.11). */
  if ((options.from as string) === (options.to as string)) {
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

    if (!source.endpoint.matches(sourceUrl)) {
      throw validationError(
        `URL path "${sourceUrl.pathname}" does not match ${options.from} endpoint`,
      );
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

    // Prompt-cache affinity (Anthropic cache_control -> OpenAI Chat
    // prompt_cache_key). Derive the identity from the *source* body and the
    // raw request, never by scanning the converted target request. Only
    // meaningful when the target is OpenAI Chat.
    const cacheEnabled = options.cache !== undefined && target.format === "openai-chat";
    const cacheAffinity = cacheEnabled
      ? await resolveCacheAffinity(
          options.cache?.resolvers ?? DEFAULT_CACHE_RESOLVERS,
          request,
          sourcePayload,
          canonicalRequest,
        )
      : undefined;

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
      const sourcePayload = source.error.renderError(canonicalError);
      emitTrace({ ...baseTrace, streaming: false });
      return new Response(JSON.stringify(sourcePayload), {
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
    const sourcePayloadJson = source.response.renderResponse(canonicalResponse, ctx);
    emitTrace({ ...baseTrace, streaming: false });
    return new Response(JSON.stringify(sourcePayloadJson), {
      status: mapStatus(targetResponse.status),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
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
}

/**
 * Streaming path (9.7, 9.9): pipe the upstream SSE body through
 * target-parse -> canonical validate -> source-render without buffering.
 * `await execute()` above only waited for response headers; first event is
 * emitted as soon as it arrives (SR-009). Cancellation propagates through the
 * Web Streams pipe to the upstream body, and request.signal was already passed
 * to the upstream fetch. Each call builds fresh parse/render TransformStreams
 * (per-request state, TC-021) wired to the request's TranslationReport.
 */
function translateStreamingResponse({
  targetResponse,
  source,
  target,
  ctx,
  baseTrace,
  emitTrace,
  keepAliveIntervalMs,
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

  const sourceStream = targetResponse.body
    .pipeThrough(createSSEParser())
    .pipeThrough(target.stream.createParse(report))
    .pipeThrough(createCanonicalValidator())
    .pipeThrough(source.stream.createRender(report));

  // The Anthropic client keeps its stream alive on periodic pings; inject them
  // while the upstream is idle so long upstream thinking streams don't look
  // dead to the SDK (GAP-013). Only applies when the source is Anthropic.
  const clientStream =
    source.format === "anthropic-messages"
      ? withAnthropicKeepAlive(sourceStream, keepAliveIntervalMs)
      : sourceStream;

  emitTrace({ ...baseTrace, streaming: true });
  return new Response(clientStream, {
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
