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
import type { SyntheticIdFactory } from "./openai-responses/ids.js";
import type { Remediations } from "../pipeline/fidelity-plan.js";

/**
 * Tool definition entry (responses.md §10.4, v0.5 P0-2).
 *
 * `executionKind` (function/custom, decides payload shape) and `nameKind`
 * (plain/namespaced, decides name flatten/restore) are orthogonal dimensions.
 * Definition-time entry: indexed by normalized tool name (no call_id exists
 * yet when a tool is defined).
 */
export interface ToolDefEntry {
  executionKind: "function" | "custom";
  nameKind: "plain" | "namespaced";
  originalName: string;
  namespace?: string;
  normalizedName: string;
  schema?: Record<string, unknown>;
}

export interface ToolDefinitionRegistry {
  map: Map<string, ToolDefEntry>;
}

/**
 * Tool call entry (responses.md §10.4, v0.4 P1-11).
 *
 * Call-time entry: indexed by call_id and item_id (double index); both maps
 * point to the same entry. `sourceItemId`/`targetItemId` bridge the Responses
 * output-item lifecycle (SSE item_id) with the call association (call_id).
 */
export interface ToolCallEntry {
  normalizedToolName: string;
  originalName: string;
  executionKind: "function" | "custom";
  nameKind?: "plain" | "namespaced";
  sourceItemId?: string;
  targetItemId?: string;
}

export interface ToolCallRegistry {
  byCallId: Map<string, ToolCallEntry>;
  byItemId: Map<string, ToolCallEntry>;
}

/** Collector for fidelity warnings + per-request tool registries. */
export interface CodecContext {
  warnings: TranslationWarning[];
  /** Tool definitions (by normalized tool name). Populated at parse time. */
  toolDefinitions?: ToolDefinitionRegistry;
  /** Tool calls (by call_id / item_id). Populated on first call encounter. */
  toolCalls?: ToolCallRegistry;
  /** Synthetic ID factory (target Responses response/SSE only, §8.3). */
  syntheticIds?: SyntheticIdFactory;
}

export function newCodecContext(): CodecContext {
  return { warnings: [] };
}

export function ensureToolDefinitionRegistry(ctx: CodecContext): ToolDefinitionRegistry {
  ctx.toolDefinitions ??= { map: new Map() };
  return ctx.toolDefinitions;
}

export function ensureToolCallRegistry(ctx: CodecContext): ToolCallRegistry {
  ctx.toolCalls ??= { byCallId: new Map(), byItemId: new Map() };
  return ctx.toolCalls;
}

/** Endpoint identity, protocol-independent enough to route across adapters. */
export interface CanonicalEndpoint {
  kind: "messages" | "chat" | "responses";
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
    /**
     * Aggregated Fidelity Plan remediations, computed by the pipeline's shared
     * Target Validate + Fidelity Plan stages (§10.0). When absent (direct
     * codec use), the renderer falls back to running its own validation.
     */
    remediations?: Remediations,
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
    ctx?: CodecContext,
  ) => TransformStream<SSEFrame, CanonicalStreamEvent>;
  createRender: (
    report?: (warning: TranslationWarning) => void,
    ctx?: CodecContext,
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
