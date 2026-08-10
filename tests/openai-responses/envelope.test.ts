/**
 * Responses Response Envelope Builder tests (responses.md §13.1.2, D-14).
 *
 * created_at allocation, item in_progress -> completed/incomplete, dedupe,
 * and usage wire serialization with cache/reasoning details. Includes the
 * Synthetic ID Factory (ids.ts).
 */
import { describe, expect, it } from "vitest";
import { ResponseEnvelopeBuilder, envelopeToWire } from "../../src/codecs/openai-responses/envelope.js";
import { createSyntheticIdFactory } from "../../src/codecs/openai-responses/ids.js";

{
  it("allocates created_at once and completes items with truncated status", () => {
    const env = new ResponseEnvelopeBuilder("resp_1", 1700000000);
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: { role: "assistant", content: [] } });
    env.addItem({ id: "msg_2", type: "message", status: "in_progress", outputIndex: 1, payload: {} });
    env.completeItem("msg_1");
    env.completeItem("msg_2", { truncated: true });
    env.setStatus("completed");
    const snap = env.snapshot();
    expect(snap.createdAt).toBe(1700000000);
    expect(snap.output[0].status).toBe("completed");
    expect(snap.output[1].status).toBe("incomplete");
    expect(snap.completedAt).toBeDefined();
  });

  it("dedupes addItem by id and serializes usage with cache/reasoning details", () => {
    const env = new ResponseEnvelopeBuilder("resp_2", 1700000000);
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: {} });
    env.addItem({ id: "msg_1", type: "message", status: "in_progress", outputIndex: 0, payload: { role: "assistant" } });
    expect(env.output).toHaveLength(1);
    env.setUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, reasoningTokens: 3 });
    const wire = envelopeToWire(env.snapshot());
    expect((wire.usage as Record<string, unknown>).input_tokens).toBe(120);
    expect(((wire.usage as Record<string, unknown>).input_tokens_details as Record<string, unknown>).cached_tokens).toBe(20);
    expect(((wire.usage as Record<string, unknown>).output_tokens_details as Record<string, unknown>).reasoning_tokens).toBe(3);
  });
}
