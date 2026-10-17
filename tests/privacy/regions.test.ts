/**
 * Request-region coverage for rich content shapes (docs/07 §8.2/§8.5).
 *
 * Exercises every region builder (text runs, JSON slots, tool schema,
 * reasoning, native partitions) so the privacy coverage stays honest for
 * images/files/annotations and nested native values.
 */
import { describe, expect, it } from "vitest";
import {
  PrivacySession,
  collectRequestRegions,
  redactRegions,
  resolvePrivacyConfig,
} from "../../src/privacy/index.js";
import type { CanonicalRequest } from "../../src/ir/types.js";

const PHONE = "13800138000";

function phoneRecognizer() {
  return {
    priority: 1,
    recognize: (text: string) => {
      const out: Array<{ start: number; end: number; type: string }> = [];
      let i = text.indexOf(PHONE);
      while (i !== -1) {
        out.push({ start: i, end: i + PHONE.length, type: "phone" });
        i = text.indexOf(PHONE, i + 1);
      }
      return out;
    },
  };
}

function richRequest(): CanonicalRequest {
  return {
    model: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: `call ${PHONE}` }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "f",
            argumentsText: JSON.stringify({ phone: PHONE }),
          },
          { type: "reasoning", text: `think ${PHONE}`, summary: `sum ${PHONE}` },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "t1",
            content: [{ type: "text", text: `res ${PHONE}` }],
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "opaque_native", sourceFormat: "openai-chat", raw: { s: "ok" } }],
      },
    ],
    tools: [
      {
        name: "f",
        description: `desc ${PHONE}`,
        inputSchema: {
          type: "object",
          properties: {
            p: { type: "string", description: PHONE, default: "x", enum: ["x", "y"] },
          },
          required: ["p"],
        },
      },
    ],
    native: {
      chat: {
        metadata: { note: PHONE },
        extra: { nested: { deep: PHONE } },
        store: false,
      },
      anthropic: {
        metadata: { m: PHONE },
        topK: 5,
        serviceTier: "standard",
      },
    },
  };
}

function sessionFor(config: ReturnType<typeof resolvePrivacyConfig>): PrivacySession {
  return new PrivacySession("regions-test", {
    compiled: config.template,
    tagMode: config.tagMode,
    tagBytes: config.tagBytes,
    namespace: config.namespace,
  });
}

describe("request region coverage", () => {
  it("collects and redacts text, JSON, schema and native regions", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [phoneRecognizer()],
      coverage: {
        reasoning: "redact",
        tool_description: "redact",
        native: {
          "chat.metadata": "redact",
          "chat.extra": "redact",
          "anthropic.metadata": "redact",
        },
      },
    });
    const canonical = richRequest();
    const { regions, extraHaystack, extensionsCoverage } = collectRequestRegions(
      canonical,
      config.coverage,
    );

    const paths = regions.map((r) => r.path);
    expect(paths.some((p) => p.endsWith(".arguments"))).toBe(true);
    expect(paths).toContain("native.chat.metadata");
    expect(paths).toContain("native.chat.extra");
    expect(paths).toContain("native.anthropic.metadata");
    expect(extensionsCoverage.some((c) => c.path === "native.chat.metadata")).toBe(true);

    const result = await redactRegions(regions, sessionFor(config), config, extraHaystack);
    expect(result.redacted).toBeGreaterThanOrEqual(5);

    const serialized = JSON.stringify(canonical);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).toContain("<private_placeholder_");
  });

  it("rejects sensitive content in a native field configured as reject", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [phoneRecognizer()],
      coverage: { reasoning: "redact", native: { "chat.metadata": "reject" } },
    });
    const canonical = richRequest();
    const { regions, extraHaystack } = collectRequestRegions(canonical, config.coverage);
    await expect(
      redactRegions(regions, sessionFor(config), config, extraHaystack),
    ).rejects.toMatchObject({ code: "privacy_uncovered_channel" });
  });
});
