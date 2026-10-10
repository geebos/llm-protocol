/**
 * Debug SSE capture (opt-in).
 *
 * When enabled, `translate()` tees the raw SSE byte streams so callers can
 * inspect exactly what crossed the wire:
 * - `upstream`: the provider's raw SSE, before parsing;
 * - `client`:   the raw SSE returned to the client, after parsing,
 *               privacy restore and rendering.
 *
 * This is a debugging facility. It is OFF by default and never writes into
 * `TranslationTrace`/`TranslationReport`. Depending on configuration it may
 * carry restored private values (client side) or model output (upstream side);
 * handling and disposal of captured data is the caller's responsibility.
 */
import type { DebugSseCapture, DebugSseChunk, DebugSseOptions, DebugSseSide } from "./types.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class DebugSseCollector {
  private readonly traceId: string;
  private readonly startedAt: number;
  private readonly maxBytes: number;
  private readonly options: DebugSseOptions;
  private readonly sides: Set<DebugSseSide>;
  private readonly text: Record<DebugSseSide, string> = { upstream: "", client: "" };
  private readonly bytes: Record<DebugSseSide, number> = { upstream: 0, client: 0 };
  private readonly sequence: Record<DebugSseSide, number> = { upstream: 0, client: 0 };
  private readonly finished: Record<DebugSseSide, boolean> = {
    upstream: false,
    client: false,
  };
  private readonly decoders: Record<DebugSseSide, TextDecoder> = {
    upstream: new TextDecoder(),
    client: new TextDecoder(),
  };
  private truncated = false;
  private finalized = false;

  constructor(options: DebugSseOptions, traceId: string, startedAt: number) {
    this.options = options;
    this.traceId = traceId;
    this.startedAt = startedAt;
    this.maxBytes =
      typeof options.maxBytes === "number" && options.maxBytes > 0
        ? options.maxBytes
        : DEFAULT_MAX_BYTES;
    const capture = options.capture ?? "upstream-sse";
    this.sides = new Set<DebugSseSide>(
      capture === "both" ? ["upstream", "client"] : [capture === "client-sse" ? "client" : "upstream"],
    );
  }

  enabled(side: DebugSseSide): boolean {
    return this.sides.has(side);
  }

  /**
   * Tee `source`; the returned stream is the pass-through branch and the tap
   * branch is drained in the background. We always keep draining after the
   * retention limit so capture never applies backpressure to the real stream.
   */
  observe<T extends Uint8Array>(
    source: ReadableStream<T>,
    side: DebugSseSide,
  ): ReadableStream<T> {
    if (!this.enabled(side)) return source;
    const [main, tap] = source.tee();
    void this.pump(tap, side);
    return main;
  }

  private async pump<T extends Uint8Array>(
    tap: ReadableStream<T>,
    side: DebugSseSide,
  ): Promise<void> {
    const reader = tap.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.bytes[side] += value.byteLength;
        if (!this.truncated) {
          const remaining = this.maxBytes - this.storedBytes(side);
          if (value.byteLength > remaining) this.truncated = true;
          const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
          this.text[side] += this.decoders[side].decode(slice, { stream: true });
        }
        this.sequence[side]++;
        this.options.onChunk?.({
          traceId: this.traceId,
          side,
          sequence: this.sequence[side],
          chunk: value,
          atMs: performance.now() - this.startedAt,
        });
      }
      if (!this.truncated) {
        this.text[side] += this.decoders[side].decode();
      }
    } catch {
      // A capture failure must never break the real stream.
    } finally {
      this.finished[side] = true;
      this.maybeFinalize();
    }
  }

  private storedBytes(side: DebugSseSide): number {
    // UTF-16 length is a close enough bound for retention purposes.
    return this.text[side].length;
  }

  /** Force completion (e.g. stream cancelled or errored). Idempotent. */
  finalize(): void {
    this.complete();
  }

  private maybeFinalize(): void {
    for (const side of this.sides) {
      if (!this.finished[side]) return;
    }
    this.complete();
  }

  private complete(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.options.onComplete?.(this.capture());
  }

  capture(): DebugSseCapture {
    const now = performance.now();
    return {
      traceId: this.traceId,
      upstream: this.sides.has("upstream") ? this.text.upstream : undefined,
      client: this.sides.has("client") ? this.text.client : undefined,
      upstreamBytes: this.bytes.upstream,
      clientBytes: this.bytes.client,
      truncated: this.truncated,
      durationMs: now - this.startedAt,
      completedAt: Date.now(),
    };
  }
}
