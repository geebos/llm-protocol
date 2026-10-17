/**
 * Property-based tests (§12.2): randomized inputs and chunking.
 * Covers Maximal Munch, streaming/serial equivalence, async ordering,
 * JSON escaping and placeholder numbering stability.
 */
import { describe, expect, it } from "vitest";
import {
  createPrivacyStreamRestore,
  PrivacySession,
  resolvePrivacyConfig,
  restoreJsonText,
  restoreString,
  type PrivacyRecognizer,
} from "../../src/index.js";
import type { CanonicalStreamEvent } from "../../src/streams/index.js";

/** Deterministic mulberry32 PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: T[]): T {
  return list[Math.floor(random() * list.length)];
}

function makeSession(id: string, mappings: number): {
  session: PrivacySession;
  config: ReturnType<typeof resolvePrivacyConfig>;
  entries: { placeholder: string; original: string }[];
} {
  const config = resolvePrivacyConfig({
    recognizers: [{ priority: 1, recognize: () => [] }],
  });
  const session = new PrivacySession(id, {
    compiled: config.template,
    tagMode: config.tagMode,
    tagBytes: config.tagBytes,
    namespace: config.namespace,
  });
  for (let i = 1; i <= mappings; i++) session.getOrCreate("a", `X${i}`);
  return { session, config, entries: session.snapshot() };
}

async function streamRestore(
  chunks: string[],
  session: PrivacySession,
  config: ReturnType<typeof resolvePrivacyConfig>,
): Promise<string> {
  const handle = createPrivacyStreamRestore(session, config, () => undefined);
  const events: CanonicalStreamEvent[] = [
    { type: "text_start", location: { choice: 0, content: 0 } },
    ...chunks.map((text): CanonicalStreamEvent => ({ type: "text_delta", location: { choice: 0, content: 0 }, text })),
    { type: "text_end", location: { choice: 0, content: 0 } },
    { type: "message_end" },
  ];
  const input = new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
  let out = "";
  const reader = input.pipeThrough(handle.stream).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text_delta") out += value.text;
  }
  return out;
}

function randomChunks(random: () => number, text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(random() * 6);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks.length ? chunks : [""];
}

describe("privacy property-based tests", () => {
  it("streamed restore equals serial restore under random chunking", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed);
      const { session, config, entries } = makeSession(`s${seed}`, 10);
      const pool = [
        "hello ",
        "x",
        "<private_placeholder_a_1>",
        "<private_placeholder_a_2>",
        "<private_placeholder_a_10>",
        "<private_placeholder_a_99>",
        "<private_pl",
        "🙂",
        " ",
      ];
      let text = "";
      const parts = 3 + Math.floor(random() * 6);
      for (let i = 0; i < parts; i++) text += pick(random, pool);
      const serial = restoreString(text, config.template, entries, 128).text;
      const streamed = await streamRestore(randomChunks(random, text), session, config);
      expect(streamed).toBe(serial);
    }
  });

  it("resolves prefix-overlapping placeholders maximally (PT-55 generalized)", async () => {
    for (let seed = 100; seed <= 130; seed++) {
      const random = rng(seed);
      const { session, config, entries } = makeSession(`p${seed}`, 12);
      const pool = Array.from({ length: 12 }, (_, i) => `<private_placeholder_a_${i + 1}>`);
      let text = "";
      for (let i = 0; i < 8; i++) text += pick(random, pool) + pick(random, ["", " ", "|"]);
      const serial = restoreString(text, config.template, entries, 128).text;
      const streamed = await streamRestore(randomChunks(random, text), session, config);
      expect(streamed).toBe(serial);
    }
  });

  it("is independent of async recognizer completion order", async () => {
    const run = async (seed: number): Promise<string> => {
      const random = rng(seed);
      const recognizers: PrivacyRecognizer[] = [1, 2, 3, 4].map((priority) => ({
        priority,
        async recognize(text: string) {
          await new Promise((r) => setTimeout(r, Math.floor(random() * 5)));
          const out = [];
          let idx = text.indexOf("13800138000");
          while (idx !== -1) {
            out.push({ start: idx, end: idx + 11, type: "phone" });
            idx = text.indexOf("13800138000", idx + 1);
          }
          return out;
        },
      }));
      const config = resolvePrivacyConfig({ recognizers });
      const session = new PrivacySession("async", {
        compiled: config.template,
        tagMode: config.tagMode,
        tagBytes: config.tagBytes,
        namespace: config.namespace,
      });
      const { redactRegions, setRegionAction } = await import("../../src/privacy/redact.js");
      const holder = { value: "13800138000 and 13800138000" };
      const region = setRegionAction(
        {
          channel: "text",
          path: "text",
          segments: [
            {
              get: () => holder.value,
              set: (v: string) => {
                holder.value = v;
              },
            },
          ],
        },
        "redact",
      );
      await redactRegions([region], session, config);
      return holder.value;
    };
    const baseline = await run(1);
    for (let seed = 2; seed <= 6; seed++) {
      expect(await run(seed)).toBe(baseline);
    }
  });

  it("keeps JSON valid for escaping-heavy values (PT-24 generalized)", () => {
    const { config, entries, session } = makeSession("json", 4);
    const originals = entries.map((e) => e.original);
    const values = ['quote " here', "back\\slash", "line\nbreak", "emoji 🙂", "\ttab"];
    for (let i = 0; i < 40; i++) {
      const random = rng(i + 1);
      const key = pick(random, originals);
      const value = pick(random, values);
      const placeholder = session.lookupOriginal("a", key)?.placeholder ?? "";
      const text = JSON.stringify({ k: placeholder, nested: { list: [value, placeholder] } });
      const restored = restoreJsonText(text, config.template, entries, 128);
      expect(restored.parseFailed).toBe(false);
      const parsed = JSON.parse(restored.text) as { k: string; nested: { list: string[] } };
      expect(parsed.k).toBe(key);
      expect(parsed.nested.list).toEqual([value, key]);
    }
  });

  it("keeps numbering stable as history grows (PT-26 generalized)", () => {
    const { session } = makeSession("grow", 0);
    const first = session.getOrCreate("a", "alpha");
    for (let i = 0; i < 20; i++) session.getOrCreate("b", `beta-${i}`);
    const again = session.getOrCreate("a", "alpha");
    expect(again.placeholder).toBe(first.placeholder);
    expect(first.placeholder).toBe("<private_placeholder_a_1>");
    const newA = session.getOrCreate("a", "gamma");
    expect(newA.placeholder).toBe("<private_placeholder_a_2>");
  });
});
