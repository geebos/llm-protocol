/**
 * Completion recorder for `translate` (05.translate-api.md §6).
 *
 * Aggregates the observable request/response facts and invokes `onComplete`
 * exactly once per call, across every exit path (success, upstream error,
 * validation/privacy failure, stream cancellation). Callback exceptions are
 * isolated so they never affect the caller's `Response`.
 */
import type { CanonicalError } from "../errors.js";
import type { ApiFormat } from "../formats.js";
import type { CanonicalStreamEvent } from "../streams/types.js";
import type { TranslateCompletion, UnifiedUsage } from "./types.js";

/** Default cap for buffered canonical SSE events (§6 rule 3). */
export const DEFAULT_MAX_SSE_EVENTS = 10_000;

export interface CompletionRecorderOptions {
  logid: string;
  from: ApiFormat;
  to: ApiFormat;
  onComplete?: (result: TranslateCompletion) => void;
  maxSseEvents?: number;
}

export class CompletionRecorder {
  readonly logid: string;
  private readonly from: ApiFormat;
  private readonly to: ApiFormat;
  private readonly onComplete?: (result: TranslateCompletion) => void;
  private readonly maxSseEvents: number;
  private readonly startedAt: number;
  private finished = false;

  private requestBody?: unknown;
  private responseHeaders?: Headers;
  private upstreamStatus?: number;
  private responseBody?: unknown;
  private sseEvents?: CanonicalStreamEvent[];
  private sseEventsTruncated = false;
  private usage?: UnifiedUsage;
  private error?: CanonicalError;

  constructor(options: CompletionRecorderOptions) {
    this.logid = options.logid;
    this.from = options.from;
    this.to = options.to;
    this.onComplete = options.onComplete;
    this.maxSseEvents = options.maxSseEvents ?? DEFAULT_MAX_SSE_EVENTS;
    this.startedAt = performance.now();
  }

  setRequestBody(body: unknown): void {
    this.requestBody = body;
  }

  setResponseMeta(headers: Headers | undefined, status: number | undefined): void {
    this.responseHeaders = headers;
    this.upstreamStatus = status;
  }

  setResponseBody(body: unknown): void {
    this.responseBody = body;
  }

  setUsage(usage: UnifiedUsage | undefined): void {
    if (usage !== undefined) this.usage = usage;
  }

  setError(error: CanonicalError | undefined): void {
    this.error = error;
  }

  /** Buffer one canonical event (bounded); never affects the real stream. */
  pushEvent(event: CanonicalStreamEvent): void {
    if (!this.sseEvents) this.sseEvents = [];
    if (this.sseEvents.length >= this.maxSseEvents) {
      this.sseEventsTruncated = true;
      return;
    }
    this.sseEvents.push(event);
  }

  /** Complete the call exactly once. */
  finish(status: TranslateCompletion["status"]): void {
    if (this.finished) return;
    this.finished = true;
    const result: TranslateCompletion = {
      logid: this.logid,
      from: this.from,
      to: this.to,
      status,
      durationMs: performance.now() - this.startedAt,
      ...(this.requestBody !== undefined ? { requestBody: this.requestBody } : {}),
      ...(this.responseHeaders !== undefined
        ? { responseHeaders: this.responseHeaders }
        : {}),
      ...(this.upstreamStatus !== undefined
        ? { upstreamStatus: this.upstreamStatus }
        : {}),
      ...(this.responseBody !== undefined ? { responseBody: this.responseBody } : {}),
      ...(this.sseEvents !== undefined ? { sseEvents: this.sseEvents } : {}),
      ...(this.sseEvents !== undefined
        ? { sseEventsTruncated: this.sseEventsTruncated }
        : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
    try {
      this.onComplete?.(result);
    } catch {
      // Callback failures are isolated from the translation result.
    }
  }
}
