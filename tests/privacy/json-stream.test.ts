/**
 * Incremental tool-argument restore (docs/04 §8.2/§8.4).
 *
 * The restorer is exercised directly (unit level) so chunk boundaries, hold
 * bounds and the opaque downgrade can be asserted precisely. Behaviour through
 * the public streaming API is covered by `stream.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  createPlaceholderMatcher,
  createToolArgumentsRestorer,
  PrivacySession,
  resolvePrivacyConfig,
  type PrivacyWarning,
  type PrivacyWarning as Warning,
  type ToolRestoreStats,
} from "../../src/privacy/index.js";

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

interface Harness {
  entries: { placeholder: string; original: string }[];
  stats: ToolRestoreStats;
  warnings: PrivacyWarning[];
  feed(chunks: string[]): string;
  restorer: ReturnType<typeof createToolArgumentsRestorer>;
  placeholder(n: number): string;
}

function makeHarness(
  overrides: { maxBytes?: number; overflowAction?: "reject" | "flush_raw" } = {},
): Harness {
  const config = resolvePrivacyConfig({
    recognizers: [{ priority: 1, recognize: () => [] }],
  });
  const session = new PrivacySession("json-stream", {
    compiled: config.template,
    tagMode: config.tagMode,
    tagBytes: config.tagBytes,
    namespace: config.namespace,
  });
  for (let i = 1; i <= 12; i++) session.getOrCreate("a", `x${i}`);
  const entries = session.snapshot();
  const warnings: PrivacyWarning[] = [];
  const stats: ToolRestoreStats = {
    restored: 0,
    unknown: 0,
    overflowed: false,
    jsonParseFailures: 0,
  };
  const restorer = createToolArgumentsRestorer({
    compiled: config.template,
    matcher: createPlaceholderMatcher(config.template, entries),
    maxPlaceholderLength: 128,
    maxBytes: overrides.maxBytes ?? 1024 * 1024,
    overflowAction: overrides.overflowAction ?? "reject",
    stats,
    report: (w: Warning) => warnings.push(w),
  });
  return {
    entries,
    stats,
    warnings,
    restorer,
    feed(chunks: string[]): string {
      let out = "";
      for (const chunk of chunks) out += restorer.feed(chunk).join("");
      out += restorer.end().join("");
      return out;
    },
    placeholder(n: number): string {
      return entries[n - 1].placeholder;
    },
  };
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function splitAt(text: string, ...points: number[]): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const point of [...points].sort((a, b) => a - b)) {
    out.push(text.slice(prev, point));
    prev = point;
  }
  out.push(text.slice(prev));
  return out.filter((chunk, i) => chunk !== "" || i === 0);
}

function parsed(text: string): unknown {
  return JSON.parse(text);
}

describe("incremental tool-argument restore", () => {
  it("restores a placeholder split across chunks (PT-05)", () => {
    const h = makeHarness();
    const doc = JSON.stringify({ a: h.placeholder(10) });
    const value = parsed(h.feed(splitEvery(doc, 5))) as { a: string };
    expect(value.a).toBe("x10");
  });

  it("waits for a longer placeholder before committing a short one", () => {
    const h = makeHarness();
    const doc = JSON.stringify({ a: h.placeholder(3) });
    const out = h.feed([doc.slice(0, doc.length - 3), doc.slice(doc.length - 3)]);
    expect((parsed(out) as { a: string }).a).toBe("x3");
  });

  it("restores a placeholder emitted with unicode escapes", () => {
    const h = makeHarness();
    const ph = h.placeholder(1);
    const escaped = ph.replace(/[\[\]<]/g, (ch) => `${BS}u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const doc = `{"a":"${escaped}"}`;
    expect((parsed(h.feed(splitEvery(doc, 7))) as { a: string }).a).toBe("x1");
  });

  it("decodes escaped literals without restoring them (INV-E7)", () => {
    const h = makeHarness();
    const literal = h.placeholder(1);
    // Request-side escaping prefixes the shape with a backslash, which JSON
    // then doubles: the wire text carries two backslashes.
    const doc = `{"a":"${BS}${BS}${literal}"}`;
    const out = h.feed(splitEvery(doc, 4));
    expect((parsed(out) as { a: string }).a).toBe(literal);
    expect(h.stats.restored).toBe(0);
  });

  it("keeps JSON valid for quoting-heavy originals (PT-24)", () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
    });
    const session = new PrivacySession("quoting", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    const original = `he said "hi"${NL}back${BS}slash 🙂`;
    const entry = session.getOrCreate("a", original);
    const warnings: PrivacyWarning[] = [];
    const stats: ToolRestoreStats = {
      restored: 0,
      unknown: 0,
      overflowed: false,
      jsonParseFailures: 0,
    };
    const restorer = createToolArgumentsRestorer({
      compiled: config.template,
      matcher: createPlaceholderMatcher(config.template, session.snapshot()),
      maxPlaceholderLength: 128,
      maxBytes: 1 << 20,
      overflowAction: "reject",
      stats,
      report: (w) => warnings.push(w),
    });
    const doc = JSON.stringify({ content: entry.placeholder, nested: { list: [entry.placeholder] } });
    let out = "";
    for (const chunk of splitEvery(doc, 3)) out += restorer.feed(chunk).join("");
    out += restorer.end().join("");
    const value = parsed(out) as { content: string; nested: { list: string[] } };
    expect(value.content).toBe(original);
    expect(value.nested.list).toEqual([original]);
  });

  it("never restores placeholders inside object keys (PT-37)", () => {
    const h = makeHarness();
    const doc = `{${JSON.stringify(h.placeholder(2))}:"v"}`;
    const out = h.feed(splitEvery(doc, 6));
    expect(Object.keys(parsed(out) as Record<string, string>)).toEqual([h.placeholder(2)]);
    expect(h.stats.restored).toBe(0);
    expect(h.warnings.some((w) => w.code === "privacy_json_key_placeholder")).toBe(true);
  });

  it("streams a large single value without waiting for its end", () => {
    const h = makeHarness();
    const body = "z".repeat(100_000);
    const doc = JSON.stringify({ file_path: "a.ts", content: body });
    const chunks = splitEvery(doc, 500);
    const first = h.restorer.feed(chunks[0]).join("");
    // The first chunk is forwarded immediately, minus at most the bounded hold.
    expect(first.length).toBeGreaterThan(chunks[0].length - 129);
    expect(first.length).toBeGreaterThan(0);
    let rest = first;
    for (const chunk of chunks.slice(1)) rest += h.restorer.feed(chunk).join("");
    rest += h.restorer.end().join("");
    expect(parsed(rest)).toEqual({ file_path: "a.ts", content: body });
  });

  it("holds at most maxPlaceholderLength while a prefix never closes", () => {
    const h = makeHarness();
    const doc = JSON.stringify({ content: h.placeholder(1).slice(0, -1).repeat(5000) });
    let out = "";
    let prevLen = 0;
    for (const chunk of splitEvery(doc, 512)) {
      out += h.restorer.feed(chunk).join("");
      // Every feed must release almost all of its input (bounded hold).
      if (chunk.length === 512) expect(out.length - prevLen).toBeGreaterThan(512 - 129);
      prevLen = out.length;
    }
    out += h.restorer.end().join("");
    expect(out.length).toBeGreaterThan(100_000);
    expect(h.stats.overflowed).toBe(false);
  });

  it("degrades to opaque passthrough on malformed JSON", () => {
    const h = makeHarness();
    const doc = `{"a":"v",${BS}x}`;
    const out = h.feed(splitEvery(doc, 4));
    expect(out).toBe(doc);
    expect(h.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
    expect(h.stats.jsonParseFailures).toBe(1);
    expect(h.restorer.degraded).toBe(true);
  });

  it("degrades when a container is unterminated", () => {
    const h = makeHarness();
    const out = h.feed([`{"a":"${h.placeholder(1)}"`]);
    expect(out).toBe(`{"a":"x1"`);
    expect(h.stats.jsonParseFailures).toBe(1);
  });

  it("degrades on excessive nesting", () => {
    const h = makeHarness();
    const doc = "[".repeat(40) + "]".repeat(40);
    h.feed(splitEvery(doc, 8));
    expect(h.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
  });

  it("rejects when the cumulative byte budget is exceeded", () => {
    const h = makeHarness({ maxBytes: 20 });
    expect(() => h.restorer.feed(JSON.stringify({ a: "y".repeat(64) }))).toThrowError(
      /privacy_buffer_overflow|buffer/i,
    );
    expect(h.stats.overflowed).toBe(true);
  });

  it("flushes raw when overflow is configured as flush_raw", () => {
    const h = makeHarness({ maxBytes: 20, overflowAction: "flush_raw" });
    const doc = JSON.stringify({ a: "y".repeat(64) });
    const out = h.feed([doc]);
    expect(out).toBe(doc);
    expect(h.stats.overflowed).toBe(true);
    expect(h.warnings.some((w) => w.code === "privacy_buffer_overflow")).toBe(true);
  });

  it("drops the unconfirmed tail on abort", () => {
    const h = makeHarness();
    const doc = `{"a":"${h.placeholder(1)}`;
    const emitted = h.restorer.feed(doc).join("");
    h.restorer.abort();
    expect(h.restorer.end()).toEqual([]);
    expect(emitted).not.toContain(h.placeholder(1).slice(0, -1));
  });

  it("passes bare scalars and non-JSON payloads through", () => {
    expect(makeHarness().feed(['"plain"'])).toBe('"plain"');
    expect(makeHarness().feed(["12345"])).toBe("12345");
    expect(makeHarness().stats.jsonParseFailures).toBe(0);
  });

  it("keeps a lone surrogate pair valid when the chunk boundary splits it", () => {
    const h = makeHarness();
    const doc = JSON.stringify({ a: "🙂" });
    const splitPoint = doc.indexOf("🙂") + 1; // between the two UTF-16 halves
    const out = h.feed([doc.slice(0, splitPoint), doc.slice(splitPoint)]);
    expect((parsed(out) as { a: string }).a).toBe("🙂");
  });

  it("decodes every JSON escape form", () => {
    const c = (n: number): string => String.fromCharCode(n);
    const h = makeHarness();
    const doc = `{"a":"x${BS}/y${BS}b${BS}f${BS}n${BS}r${BS}t${BS}"q${BS}${BS}z"}`;
    const expected =
      "x/y" + c(8) + c(12) + c(10) + c(13) + c(9) + '"q' + BS + "z";
    expect((parsed(h.feed(splitEvery(doc, 5))) as { a: string }).a).toBe(expected);
    expect(h.stats.jsonParseFailures).toBe(0);
  });

  it("degrades on an invalid escape sequence", () => {
    const h = makeHarness();
    const doc = `{"a":"x${BS}q"}`;
    expect(h.feed(splitEvery(doc, 4))).toBe(doc);
    expect(h.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
  });

  it("degrades on a raw control character inside a string", () => {
    const h = makeHarness();
    const doc = `{"a":"x${String.fromCharCode(1)}"}`;
    expect(h.feed(splitEvery(doc, 4))).toBe(doc);
    expect(h.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
  });

  it("degrades on mismatched structure", () => {
    const cases = ['{"a":1]', '{"a" 1}', '{"a":1 2}', "{}:1", "1:2"];
    for (const doc of cases) {
      const h = makeHarness();
      expect(h.feed([doc])).toBe(doc);
      expect(h.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
    }
  });

  it("commits an unterminated string at tool end and warns", () => {
    const h = makeHarness();
    const doc = `{"a":"${h.placeholder(1)}`;
    expect(h.feed([doc])).toBe(`{"a":"x1`);
    expect(h.stats.jsonParseFailures).toBe(1);
  });

  it("keeps a dangling escape sequence at tool end", () => {
    const h = makeHarness();
    const doc = `{"a":"x${BS}`;
    expect(h.feed([doc])).toBe(doc);
    expect(h.stats.jsonParseFailures).toBe(1);
  });

  it("keeps a surrogate pair split inside a key intact", () => {
    const h = makeHarness();
    const doc = `{${JSON.stringify("🙂")}:"v"}`;
    const splitPoint = doc.indexOf("🙂") + 1;
    expect(h.feed([doc.slice(0, splitPoint), doc.slice(splitPoint)])).toBe(doc);
  });

  it("tracks the cumulative upstream byte count", () => {
    const h = makeHarness();
    h.feed(['{"a":', '"b"}']);
    expect(h.restorer.bytes).toBe('{"a":'.length + '"b"}'.length);
  });

  it("is chunk-boundary independent (docs/06 §9.3)", () => {
    const h = makeHarness();
    const doc = JSON.stringify({
      plain: "no placeholders here",
      value: h.placeholder(4),
      nested: { list: [1, 2.5, true, null, h.placeholder(5)], quote: 'a"b' },
      unicode: "🙂🙃",
    });
    const whole = h.feed([doc]);
    for (let size = 1; size <= 17; size++) {
      const h2 = makeHarness();
      expect(h2.feed(splitEvery(doc, size))).toBe(whole);
    }
  });

  it("matches the non-streaming restore result (differential oracle)", async () => {
    const { restoreJsonText } = await import("../../src/privacy/index.js");
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
    });
    const h = makeHarness();
    const doc = JSON.stringify({
      a: h.placeholder(1),
      list: [h.placeholder(2), "text", 7, { deep: h.placeholder(3) }],
    });
    const incremental = parsed(h.feed(splitEvery(doc, 6)));
    const oracle = restoreJsonText(doc, config.template, h.entries, 128);
    expect(oracle.parseFailed).toBe(false);
    expect(incremental).toEqual(parsed(oracle.text));
  });
});

/**
 * Scale guards (§8.4). Deliberately loose: an O(n) pass over a megabyte is a
 * few milliseconds, so CI jitter cannot flake these while a quadratic
 * regression or an unbounded hold still fails hard.
 */
describe("incremental tool-argument restore scale", () => {
  const guard = (label: string, fn: () => void): number => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    expect(best, `${label} exceeded its time budget`).toBeLessThan(500);
    return best;
  };

  it("converts 200 KB across 400 chunks within budget", () => {
    guard("200KB/400 chunks", () => {
      const h = makeHarness({ maxBytes: 8 << 20 });
      const doc = JSON.stringify({ content: "x".repeat(200_000) });
      for (const chunk of splitEvery(doc, 512)) h.restorer.feed(chunk);
      h.restorer.end();
    });
  });

  it("stays linear between 1 MB and 2 MB", () => {
    const time = (size: number): number =>
      guard(`${size}B`, () => {
        const h = makeHarness({ maxBytes: 8 << 20 });
        const doc = JSON.stringify({ content: "y".repeat(size) });
        for (const chunk of splitEvery(doc, 512)) h.restorer.feed(chunk);
        h.restorer.end();
      });
    time(500_000);
    const small = time(1_000_000);
    const large = time(2_000_000);
    expect(large / Math.max(small, 0.05)).toBeLessThan(3);
  });

  it("keeps the hold bounded on a 5000-repetition partial prefix", () => {
    const h = makeHarness();
    const doc = JSON.stringify({ content: h.placeholder(1).slice(0, -1).repeat(5000) });
    let out = "";
    for (const chunk of splitEvery(doc, 512)) {
      out += h.restorer.feed(chunk).join("");
    }
    out += h.restorer.end().join("");
    expect(out.length).toBe(doc.length);
  });
});
