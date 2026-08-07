/**
 * Protocol adapter contract (4.2, 9.4-9.7).
 *
 * Each protocol ships an independent adapter composed of endpoint, header,
 * request, response and error codecs. Codecs are synchronous pure functions
 * over parsed payloads; they never touch the network.
 */
import type { ApiFormat } from "../formats.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { CanonicalRequest } from "../ir/types.js";
import type { CanonicalResponse } from "../ir/response.js";
import type { CanonicalError } from "../errors.js";
import type { TranslationWarning } from "../ir/fidelity.js";
import type { SSEFrame } from "../streams/sse-parser.js";
import type { CanonicalStreamEvent } from "../streams/types.js";

/** Collector for fidelity warnings produced during a single translation. */
export interface CodecContext {
  warnings: TranslationWarning[];
}

export function newCodecContext(): CodecContext {
  return { warnings: [] };
}

/** Endpoint identity, protocol-independent enough to route across adapters. */
export interface CanonicalEndpoint {
  kind: "messages" | "chat";
  query: Record<string, string>;
}

export interface EndpointCodec {
  matches(url: URL): boolean;
  toCanonical(url: URL): CanonicalEndpoint;
  fromCanonical(endpoint: CanonicalEndpoint, targetOrigin: URL): URL;
}

/** Credential value handled as an opaque string; never enters IR or reports. */
export interface CanonicalCredential {
  kind: "api-key" | "bearer";
  value: string;
}

export interface HeaderCodec {
  parseCredential(headers: Headers): CanonicalCredential | undefined;
  /** Sanitize source headers, apply target defaults, render credential. */
  renderTargetHeaders(
    headers: Headers,
    credential: CanonicalCredential | undefined,
  ): Headers;
}

export interface RequestCodec {
  detectStreaming(payload: unknown): boolean;
  parseRequest(payload: unknown, ctx?: CodecContext): CanonicalRequest;
  renderRequest(
    canonical: CanonicalRequest,
    streaming: boolean,
    ctx?: CodecContext,
  ): unknown;
}

export interface ResponseCodec {
  parseResponse(payload: unknown, ctx?: CodecContext): CanonicalResponse;
  renderResponse(canonical: CanonicalResponse, ctx?: CodecContext): unknown;
}

export interface ErrorCodec {
  parseError(payload: unknown, status?: number): CanonicalError;
  renderError(error: CanonicalError): unknown;
}

/**
 * SSE stream codec: target parse + source render over canonical events.
 *
 * `createParse`/`createRender` are factories: every streamed request gets a
 * fresh TransformStream so per-stream state (block maps, tool indexes) never
 * leaks across requests on a reused translate() factory (TC-021). Each factory
 * receives a `report` callback so stream-time fidelity decisions (e.g. a
 * synthesized tool-call id) land in the TranslationReport (TR-002).
 */
export interface StreamCodec {
  createParse: (
    report?: (warning: TranslationWarning) => void,
  ) => TransformStream<SSEFrame, CanonicalStreamEvent>;
  createRender: (
    report?: (warning: TranslationWarning) => void,
  ) => TransformStream<CanonicalStreamEvent, Uint8Array>;
}

export interface ProtocolAdapter {
  format: ApiFormat;
  /** Effective profile (default or caller-supplied) driving capability gates. */
  profile: ProviderProfile;
  endpoint: EndpointCodec;
  headers: HeaderCodec;
  request: RequestCodec;
  response: ResponseCodec;
  error: ErrorCodec;
  stream: StreamCodec;
}
