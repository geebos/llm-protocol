/**
 * Streaming restore invariants (P3/P4): token hold points across chunks and
 * JSON-aware tool-argument restore. Covers PT-04/05/06/07/13/14/30/36/41/55/63.
 */
import { describe, expect, it } from "vitest";
import {
  createPrivacyStreamRestore,
  PrivacySession,
  resolvePrivacyConfig,
  type PrivacyWarning,
} from "../../src/privacy/index.js";
import type { CanonicalStreamEvent } from "../../src/streams/index.js";

/** Partial placeholder start (prefix + separator, no type yet). */
const PARTIAL = "{PP-";
/** A longer partial prefix: exceeds the small overflow budgets in these tests. */
const overflowText = `${PARTIAL}abcdef`;

function makeSession(mappings: number): {
  session: PrivacySession;
  config: ReturnType<typeof resolvePrivacyConfig>;
  token(n: number): string;
} {
  const config = resolvePrivacyConfig({
    recognizers: [{ priority: 1, recognize: () => [] }],
  });
  const session = new PrivacySession("stream-test", {
    compiled: config.template,
    namespace: config.namespace,
  });
  for (let i = 1; i <= mappings; i++) {
    session.getOrCreate("a", `x${i}`);
  }
  return {
    session,
    config,
    token: (n: number) => session.entries()[n - 1].placeholder,
  };
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
  const reader = input.pipeThrough(handle.stream).getReader();
  const out: CanonicalStreamEvent[] = [];
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
  it("restores a token split across chunk boundaries (PT-55)", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(1);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `see ${t.slice(0, 12)}` },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `${t.slice(12)} end` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("see x1 end");
  });

  it("holds a partial tag until it completes (PT-63)", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(2);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: t.slice(0, t.length - 2) },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `${t.slice(t.length - 2)} tail` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x2 tail");
  });

  it("does not restore a token that never completes", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(1);
    const truncated = t.slice(0, t.length - 3);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: truncated },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe(truncated);
    expect(result.warnings.some((w) => w.code === "privacy_unknown_placeholder")).toBe(true);
  });

  it("restores a completed token immediately", async () => {
    const { session, config, token } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: token(1) },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: " tail" },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x1 tail");
  });

  it("restores buffered tool arguments as valid JSON (PT-05)", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(1);
    const result = await run(
      [
        { type: "tool_start", location: { choice: 0, content: 0 }, id: "call_1", name: "f" },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: `{"a":"${t.slice(0, 6)}`,
        },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: `${t.slice(6)}","b":[1,2]}`,
        },
        { type: "tool_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const json = result.events
      .filter((e): e is Extract<CanonicalStreamEvent, { type: "tool_arguments_delta" }> => e.type === "tool_arguments_delta")
      .map((e) => e.partialJson)
      .join("");
    expect(JSON.parse(json)).toEqual({ a: "x1", b: [1, 2] });
    // Lifecycle preserved: start/tool_end pairing intact.
    expect(result.events[0].type).toBe("tool_start");
    expect(result.events[result.events.length - 2].type).toBe("tool_end");
  });

  it("emits tool argument deltas before tool_end (incremental)", async () => {
    const { session, config, token } = makeSession(10);
    const result = await run(
      [
        { type: "tool_start", location: { choice: 0, content: 0 }, id: "call_1", name: "f" },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: '{"a":"',
        },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: token(10),
        },
        { type: "tool_arguments_delta", location: { choice: 0, content: 0 }, partialJson: '"}' },
        { type: "tool_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const argEvents = result.events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: "tool_arguments_delta" }> =>
        e.type === "tool_arguments_delta",
    );
    // Arguments flow incrementally, never as a single block at `tool_end`.
    expect(argEvents.length).toBeGreaterThan(1);
    expect(result.events.indexOf(argEvents[0])).toBeLessThan(
      result.events.findIndex((e) => e.type === "tool_end"),
    );
    expect(JSON.parse(argEvents.map((e) => e.partialJson).join(""))).toEqual({ a: "x10" });
  });

  it("warns and leaves malformed tool arguments unrestored (PT-05)", async () => {
    const { session, config, token } = makeSession(10);
    const malformed = `{"a":${token(1)}}`;
    const result = await run(
      [
        { type: "tool_start", location: { choice: 0, content: 0 }, id: "call_1", name: "f" },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: malformed,
        },
        { type: "tool_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const json = result.events
      .filter(
        (e): e is Extract<CanonicalStreamEvent, { type: "tool_arguments_delta" }> =>
          e.type === "tool_arguments_delta",
      )
      .map((e) => e.partialJson)
      .join("");
    expect(json).toBe(malformed);
    expect(result.warnings.some((w) => w.code === "privacy_json_parse_failed")).toBe(true);
  });

  it("drops the unconfirmed tool tail when an error terminates the stream", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(1);
    const result = await run(
      [
        { type: "tool_start", location: { choice: 0, content: 0 }, id: "call_1", name: "f" },
        {
          type: "tool_arguments_delta",
          location: { choice: 0, content: 0 },
          partialJson: `{"a":"${t.slice(0, 8)}`,
        },
        { type: "error", error: { kind: "upstream", message: "boom" } },
      ],
      session,
      config,
    );
    const json = result.events
      .filter(
        (e): e is Extract<CanonicalStreamEvent, { type: "tool_arguments_delta" }> =>
          e.type === "tool_arguments_delta",
      )
      .map((e) => e.partialJson)
      .join("");
    expect(json).not.toContain(t.slice(0, 8));
    expect(result.events.some((e) => e.type === "error")).toBe(true);
  });

  it("does not restore unknown tokens and warns for a mangled one (PT-07)", async () => {
    const { session, config, token } = makeSession(1);
    // Same type, wrong tag: the model rewrote a token we issued. The wrong tag
    // must stay inside the base32 alphabet, otherwise it is not token-shaped.
    const issued = token(1);
    const last = issued[issued.length - 1] === "a" ? "b" : "a";
    const mangled = `${issued.slice(0, -1)}${last}`;
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `x ${mangled} y` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe(`x ${mangled} y`);
    expect(result.warnings.some((w) => w.code === "privacy_unknown_placeholder")).toBe(true);
  });

  it("leaves a token of an unknown type alone without warning", async () => {
    const { session, config } = makeSession(1);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        {
          type: "text_delta",
          location: { choice: 0, content: 0 },
          text: `see ${PARTIAL}other-abcde} y`,
        },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe(`see ${PARTIAL}other-abcde} y`);
    expect(result.warnings).toHaveLength(0);
  });

  it("restores a default tag token split across chunks", async () => {
    const { session, config, token } = makeSession(1);
    const t = token(1);
    expect(t).toMatch(/^\{PP-a-[a-z2-7]{5}\}$/);
    const cut = t.length - 2;
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `call ${t.slice(0, cut)}` },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `${t.slice(cut)} now` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("call x1 now");
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects on buffer overflow in strict mode (PT-14)", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
      streaming: { maxTextPendingBytes: 5 },
    });
    const session = new PrivacySession("overflow", {
      compiled: config.template,
      namespace: config.namespace,
    });
    await expect(
      run(
        [
          { type: "text_start", location: { choice: 0, content: 0 } },
          { type: "text_delta", location: { choice: 0, content: 0 }, text: overflowText },
          { type: "text_end", location: { choice: 0, content: 0 } },
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
      namespace: config.namespace,
    });
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: overflowText },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toContain(overflowText);
    expect(result.warnings.some((w) => w.code === "privacy_buffer_overflow")).toBe(true);
  });

  it("emits an incomplete placeholder as-is at EOF with a warning (PT-36)", async () => {
    const { session, config, token } = makeSession(10);
    const truncated = token(1).slice(0, -1);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `tail ${truncated}` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe(`tail ${truncated}`);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("aborts on an incomplete placeholder when strictStreaming is set (PT-36)", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [{ priority: 1, recognize: () => [] }],
      streaming: { strictStreaming: true },
    });
    const session = new PrivacySession("strict-stream", {
      compiled: config.template,
      namespace: config.namespace,
    });
    await expect(
      run(
        [
          { type: "text_start", location: { choice: 0, content: 0 } },
          { type: "text_delta", location: { choice: 0, content: 0 }, text: `x ${PARTIAL}` },
          { type: "text_end", location: { choice: 0, content: 0 } },
          { type: "message_end" },
        ],
        session,
        config,
      ),
    ).rejects.toMatchObject({ code: "privacy_unknown_placeholder" });
  });

  it("drops buffered text when an error event terminates the stream", async () => {
    const { session, config, token } = makeSession(10);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `partial ${token(1).slice(0, 8)}` },
        { type: "error", error: { kind: "upstream", message: "boom" } },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).not.toContain("{private_placeholder");
    expect(result.events.some((e) => e.type === "error")).toBe(true);
  });

  it("keeps per-index buffers independent (PT-06)", async () => {
    const { session, config, token } = makeSession(10);
    const a = token(1);
    const b = token(2);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_start", location: { choice: 0, content: 1 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: a.slice(0, 10) },
        { type: "text_delta", location: { choice: 0, content: 1 }, text: `other ${b.slice(0, 10)}` },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: a.slice(10) },
        { type: "text_delta", location: { choice: 0, content: 1 }, text: b.slice(10) },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "text_end", location: { choice: 0, content: 1 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    const byIndex = (index: number): string =>
      result.events
        .filter(
          (e): e is Extract<CanonicalStreamEvent, { type: "text_delta" }> =>
            e.type === "text_delta" && e.location.content === index,
        )
        .map((e) => e.text)
        .join("");
    expect(byIndex(0)).toBe("x1");
    expect(byIndex(1)).toBe("other x2");
  });

  it("preserves restore state across an unknown event (PT-53)", async () => {
    const { session, config, token } = makeSession(10);
    const t = token(1);
    const result = await run(
      [
        { type: "text_start", location: { choice: 0, content: 0 } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: t.slice(0, 9) },
        { type: "unknown", sourceType: "ping", raw: { type: "ping" } },
        { type: "text_delta", location: { choice: 0, content: 0 }, text: `${t.slice(9)} tail` },
        { type: "text_end", location: { choice: 0, content: 0 } },
        { type: "message_end" },
      ],
      session,
      config,
    );
    expect(deltas(result.events)).toBe("x1 tail");
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
