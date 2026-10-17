/**
 * Request-scoped privacy session (PR-004, §4.3/§10.1).
 *
 * Deterministic placeholder allocation: the same `(type, original)` pair
 * always yields the same placeholder within one session, and numbering is
 * isolated per type. Allocation is synchronous and atomic (`getOrCreate` has
 * no `await`) so async recognizer completion order can never change numbering
 * (INV-7/INV-8).
 */
import { randomBytes } from "node:crypto";
import type { MappingEntry, PrivacySessionView } from "./types.js";
import {
  renderPlaceholder,
  tokenTag,
  type CompiledTemplate,
} from "./template.js";

export interface SessionConfig {
  compiled: CompiledTemplate;
  /** Tenant namespace mixed into the tag seed; default empty. */
  namespace?: string;
  /**
   * Tag key. Supplied by the caller when tokens must stay stable across
   * processes; the default is a per-process random key, which keeps tokens
   * stable across requests (prompt-cache affinity) without linking processes.
   */
  tagKey?: Uint8Array;
}

/**
 * Per-process default tag key. Stable across requests so identical values keep
 * identical tokens (cache affinity, log correlation), while a fresh process
 * starts from a different key.
 */
const PROCESS_TAG_KEY = randomBytes(32);

export class PrivacySession implements PrivacySessionView {
  readonly id: string;
  /** Compiled placeholder template shared by redact and restore. */
  readonly compiled: CompiledTemplate;
  version = 0;
  activeStreams = 0;

  private readonly key: Uint8Array;
  private readonly namespace: string;
  private readonly placeholderToReal = new Map<string, MappingEntry>();
  private readonly realToPlaceholder = new Map<string, MappingEntry>();
  private readonly counters = new Map<string, number>();

  constructor(id: string, config: SessionConfig) {
    this.id = id;
    this.compiled = config.compiled;
    this.namespace = config.namespace ?? "";
    this.key = config.tagKey ?? PROCESS_TAG_KEY;
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

    const compiled = this.compiled;
    let entry: MappingEntry;
    if (compiled.tagMode) {
      // Identity is the tag; the same (type, value) always maps to the same
      // token inside this session. `salt` only advances on a truncated-digest
      // collision between two distinct values of the same type.
      let salt = 0;
      // A custom tag-mode template may keep `{N}`; identity is still the tag,
      // so the counter is positional (allocation order) only.
      let n = compiled.hasN ? (this.counters.get(type) ?? 0) + 1 : undefined;
      for (;;) {
        const tag = tokenTag(
          this.key,
          this.namespace,
          type,
          original,
          compiled.tagLength,
          salt,
        );
        const placeholder = renderPlaceholder(compiled, type, n, tag);
        if (!this.placeholderToReal.has(placeholder)) {
          if (n !== undefined) this.counters.set(type, n);
          entry = {
            id: `${type}:${tag}`,
            type,
            original,
            placeholder,
            createdAt: Date.now(),
          };
          break;
        }
        salt++;
        if (n !== undefined) n++;
      }
    } else {
      let n = (this.counters.get(type) ?? 0) + 1;
      let placeholder = renderPlaceholder(compiled, type, n);
      while (this.placeholderToReal.has(placeholder)) {
        n++;
        placeholder = renderPlaceholder(compiled, type, n);
      }
      this.counters.set(type, n);
      entry = {
        id: `${type}:${n}`,
        type,
        original,
        placeholder,
        createdAt: Date.now(),
      };
    }

    this.placeholderToReal.set(entry.placeholder, entry);
    this.realToPlaceholder.set(key, entry);
    this.version++;
    return entry;
  }
}
