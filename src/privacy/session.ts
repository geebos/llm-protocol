/**
 * Request-scoped privacy session (PR-004, §4.3/§10.1).
 *
 * Deterministic placeholder allocation: the same `(type, original)` pair
 * always yields the same placeholder within one session, and numbering is
 * isolated per type. Allocation is synchronous and atomic (`getOrCreate` has
 * no `await`) so async recognizer completion order can never change numbering
 * (INV-7/INV-8).
 */
import type { MappingEntry, PrivacySessionView } from "./types.js";
import {
  derivedPlaceholderN,
  placeholderTag,
  renderPlaceholder,
  type CompiledTemplate,
} from "./template.js";

export interface SessionConfig {
  compiled: CompiledTemplate;
  tagMode: boolean;
  tagBytes: number;
  namespace: string;
  tagKey?: Uint8Array;
  /** Placeholder identifier mode (docs/06 §10.2); default "sequence". */
  idMode?: "sequence" | "derived";
  /** Stable context id required by `idMode: "derived"`. */
  contextId?: string;
}

export class PrivacySession implements PrivacySessionView {
  readonly id: string;
  /** Compiled placeholder template shared by redact and restore. */
  readonly compiled: CompiledTemplate;
  version = 0;
  activeStreams = 0;

  private readonly config: SessionConfig;
  private readonly placeholderToReal = new Map<string, MappingEntry>();
  private readonly realToPlaceholder = new Map<string, MappingEntry>();
  private readonly counters = new Map<string, number>();

  constructor(id: string, config: SessionConfig) {
    this.id = id;
    this.config = config;
    this.compiled = config.compiled;
  }

  lookupPlaceholder(placeholder: string): MappingEntry | undefined {
    return this.placeholderToReal.get(placeholder);
  }

  lookupOriginal(type: string, original: string): MappingEntry | undefined {
    return this.realToPlaceholder.get(`${type}\u0000${original}`);
  }

  entries(): MappingEntry[] {
    return [...this.placeholderToReal.values()];
  }

  /** Snapshot entries for an immutable streaming matcher. */
  snapshot(): { placeholder: string; original: string }[] {
    return this.entries().map((e) => ({
      placeholder: e.placeholder,
      original: e.original,
    }));
  }

  acquireStream(): void {
    this.activeStreams++;
  }

  releaseStream(): void {
    if (this.activeStreams > 0) this.activeStreams--;
  }

  /**
   * Return the stable mapping for `(type, original)`, allocating one when
   * absent. Synchronous by design.
   */
  getOrCreate(type: string, original: string): MappingEntry {
    const key = `${type}\u0000${original}`;
    const existing = this.realToPlaceholder.get(key);
    if (existing) return existing;

    let n: number;
    if (
      this.config.idMode === "derived" &&
      this.config.tagKey &&
      this.config.contextId
    ) {
      n = derivedPlaceholderN(
        this.config.tagKey,
        this.config.contextId,
        type,
        original,
      );
    } else {
      n = (this.counters.get(type) ?? 0) + 1;
    }
    const { compiled, tagMode, tagBytes, namespace, tagKey } = this.config;
    const tag =
      tagMode && tagKey
        ? placeholderTag(tagKey, namespace, type, original, tagBytes)
        : undefined;
    let placeholder = renderPlaceholder(compiled, type, n, tag);
    while (this.placeholderToReal.has(placeholder)) {
      n++;
      placeholder = renderPlaceholder(compiled, type, n, tag);
    }
    if (this.config.idMode !== "derived") {
      this.counters.set(type, n);
    }

    const entry: MappingEntry = {
      id: `${type}:${n}`,
      type,
      original,
      placeholder,
      createdAt: Date.now(),
    };
    this.placeholderToReal.set(placeholder, entry);
    this.realToPlaceholder.set(key, entry);
    this.version++;
    return entry;
  }
}
