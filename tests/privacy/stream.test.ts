/**
 * Streaming restore invariants (P3/P4): Maximal Munch across chunks and
 * JSON-aware tool-argument restore. Covers PT-04/05/55/63.
 */
import { describe, expect, it } from "vitest";
import {
  createPrivacyStreamRestore,
  PrivacySession,
  resolvePrivacyConfig,
  type PrivacyWarning,
} from "../../src/privacy/index.js";
import type { CanonicalStreamEvent } from "../../src/streams/index.js";

function makeSession(mappings: number): {
  session: PrivacySession;
  config: ReturnType<typeof resolvePrivacyConfig>;
} {
  const config = resolvePrivacyConfig({
    recognizers: [{ priority: 1, recognize: () => [] }],
  });
  const session = new PrivacySession("stream-test", {
    compiled: config.template,
    tagMode: config.tagMode,
    tagBytes: config.tagBytes,
    namespace: config.namespace,
  });
  for (let i = 1; i <= mappings; i++) {
    session.getOrCreate("a", `x${i}`);
  }
  return { session, config };
}

async function run(
  events: CanonicalStreamEvent[],
  session: PrivacySession,
  config: ReturnType<typeof resolvePrivacyConfig>,
): Promise<{ events: CanonicalStreamEvent[]; warnings: PrivacyWarning[] }> {
  const warnings: PrivacyWarning[] = [];
  const handle = createPrivacyStreamRestore(session, config, (w) => warnings.push(w));
  const input = new ReadableStream<CanonicalStreamEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
  const out: CanonicalStreamEvent[] = [];
  const reader = input.pipeThrough(handle.stream).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return { events: out, warnings };
}

function deltas(events: CanonicalStreamEvent[]): string {
  return events
    .filter((e): e is Extract<CanonicalStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
}

describe("streaming restore", () => {
  it("uses maximal munch across a chunk boundary (PT-55)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "see <private_placeholder_a_1" },
        { type: "text_delta", index: 0, text: "0> end" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("see x10 end");
  });

  it("waits for a longer placeholder before committing a short one (PT-63)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "<private_placeholder_a_1" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    // Incomplete at end of stream: emitted as-is, never partially restored.
    expect(deltas(result.events)).toBe("<private_placeholder_a_1");
  });

  it("restores a completed short placeholder immediately", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "<private_placeholder_a_1>" },
        { type: "text_delta", index: 0, text: " tail" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x1 tail");
  });

  it("restores buffered tool arguments as valid JSON (PT-05)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "tool_start", index: 0, id: "call_1", name: "f" },
        { type: "tool_arguments_delta", index: 0, partialJson: '{"a":"<private_placeholder_a_1' },
        { type: "tool_arguments_delta", index: 0, partialJson: '0>","b":[1,2]}' },
        { type: "tool_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const json = result.events
      .filter((e): e is Extract<CanonicalStreamEvent, { type: "tool_arguments_delta" }> => e.type === "tool_arguments_delta")
      .map((e) => e.partialJson)
      .join("");
    expect(JSON.parse(json)).toEqual({ a: "x10", b: [1, 2] });
    // Lifecycle preserved: start/tool_end pairing intact.
    expect(result.events[0].type).toBe("tool_start");
    expect(result.events[result.events.length - 2].type).toBe("tool_end");
  });

  it("does not restore unknown placeholders and warns (PT-07)", async () => {
    const { session, config } = makeSession(1);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "x <private_placeholder_a_42> y" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x <private_placeholder_a_42> y");
    expect(result.warnings.some((w) => w.code === "privacy_unknown_placeholder")).toBe(true);
  });

  it("rejects on buffer overflow in strict mode (PT-14)", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
      streaming: { maxTextPendingBytes: 5 },
    });
    const session = new PrivacySession("overflow", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    await expect(
      run(
        [
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, text: "<private_placeholder_" },
          { type: "text_end", index: 0 },
          { type: "message_end" },
        ],
        session,
        config,
      ),
    ).rejects.toMatchObject({ code: "privacy_buffer_overflow" });
  });

  it("flushes raw on overflow in best_effort mode (PT-14)", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
      securityMode: "best_effort",
      streaming: { maxTextPendingBytes: 5, overflowAction: "flush_raw" },
    });
    const session = new PrivacySession("flush", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "<private_placeholder_" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toContain("<private_placeholder_");
    expect(result.warnings.some((w) => w.code === "privacy_buffer_overflow")).toBe(true);
  });

  it("emits an incomplete placeholder as-is at EOF with a warning (PT-36)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "tail <private_placeholder_a_1" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("tail <private_placeholder_a_1");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("aborts on an incomplete placeholder when strictStreaming is set (PT-36)", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
      streaming: { strictStreaming: true },
    });
    const session = new PrivacySession("strict-stream", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    await expect(
      run(
        [
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, text: "x <private_placeholder_" },
          { type: "text_end", index: 0 },
          { type: "message_end" },
        ],
        session,
        config,
      ),
    ).rejects.toMatchObject({ code: "privacy_unknown_placeholder" });
  });

  it("drops buffered text when an error event terminates the stream", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "partial <private_placeholder_a_1" },
        { type: "error", error: { kind: "upstream", message: "boom" } },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).not.toContain("<private_placeholder");
    expect(result.events.some((e) => e.type === "error")).toBe(true);
  });

  it("keeps per-index buffers independent (PT-06)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_start", index: 1 },
        { type: "text_delta", index: 0, text: "<private_placeholder_a_1" },
        { type: "text_delta", index: 1, text: "other <private_placeholder_a_2" },
        { type: "text_delta", index: 0, text: "0>" },
        { type: "text_delta", index: 1, text: ">" },
        { type: "text_end", index: 0 },
        { type: "text_end", index: 1 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const byIndex = (index: number): string =>
      result.events
        .filter(
          (e): e is Extract<CanonicalStreamEvent, { type: "text_delta" }> =>
            e.type === "text_delta" && e.index === index,
        )
        .map((e) => e.text)
        .join("");
    expect(byIndex(0)).toBe("x10");
    expect(byIndex(1)).toBe("other x2");
  });

  it("preserves restore state across an unknown event (PT-53)", async () => {
    const { session, config } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "<private_placeholder_a_1" },
        { type: "unknown", sourceType: "ping", raw: { type: "ping" } },
        { type: "text_delta", index: 0, text: "0> tail" },
        { type: "text_end", index: 0 },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x10 tail");
    expect(result.events.some((e) => e.type === "unknown")).toBe(true);
  });

  it("releases the stream reference count on completion (PT-13)", async () => {
    const { session, config } = makeSession(1);
    expect(session.activeStreams).toBe(0);
    const handle = createPrivacyStreamRestore(session, config, () => undefined);
    expect(session.activeStreams).toBe(1);
    const input = new ReadableStream<CanonicalStreamEvent>({
      start(controller) {
        controller.enqueue({ type: "message_end" });
        controller.close();
      },
    });
    const reader = input.pipeThrough(handle.stream).getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(session.activeStreams).toBe(0);
  });

  it("releases state when the consumer cancels (PT-30/41)", async () => {
    const { session, config } = makeSession(10);
    const handle = createPrivacyStreamRestore(session, config, () => undefined);
    expect(session.activeStreams).toBe(1);
    handle.abort();
    expect(session.activeStreams).toBe(0);
  });
});
