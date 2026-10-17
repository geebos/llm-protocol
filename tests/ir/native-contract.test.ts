/**
 * IR native-partition contract tests (docs/07.ir-native-codec.md P1 + §15 errata).
 *
 * Verify the type-level contract without touching codec behaviour: bidirectional
 * projection context, unified stream block keys, unified cache accessor,
 * field-policy tables, and fidelity accounting for drops/adaptations.
 */
import { describe, expect, it } from "vitest";
import { projectionContext } from "../../src/ir/projection/context.js";
import {
  createStreamBlockKey,
  streamBlockKey,
  streamBlockKeyId,
} from "../../src/ir/stream-key.js";
import { getCacheControl } from "../../src/ir/native/accessors.js";
import { calculateFidelity } from "../../src/ir/projection/fidelity.js";
import {
  ANTHROPIC_REQUEST_POLICY,
  CHAT_REQUEST_POLICY,
} from "../../src/ir/policy/request.js";
import { anthropicDefaultProfile } from "../../src/codecs/anthropic-messages/index.js";
import { openaiChatDefaultProfile } from "../../src/codecs/openai-chat/index.js";
import type { CanonicalTool, ContentPart } from "../../src/ir/types.js";
import type { DropRecord, FeatureAdaptationRecord } from "../../src/ir/projection/drop-record.js";
import type { FieldPolicy, FieldPolicyContext } from "../../src/ir/policy/policy.js";

const ctx = (value: unknown): FieldPolicyContext => ({
  phase: "request",
  inputFormat: "openai-chat",
  outputFormat: "anthropic-messages",
  inputProfile: openaiChatDefaultProfile,
  outputProfile: anthropicDefaultProfile,
  path: "n",
  value,
});

const resolve = (policy: FieldPolicy, context: FieldPolicyContext) =>
  typeof policy === "function" ? policy(context) : policy;

describe("ProjectionContext direction (P0-1)", () => {
  it("request projection goes from -> to", () => {
    const c = projectionContext(
      "request",
      "anthropic-messages",
      "openai-chat",
      anthropicDefaultProfile,
      openaiChatDefaultProfile,
    );
    expect(c.inputFormat).toBe("anthropic-messages");
    expect(c.outputFormat).toBe("openai-chat");
    expect(c.inputProfile).toBe(anthropicDefaultProfile);
    expect(c.outputProfile).toBe(openaiChatDefaultProfile);
  });

  it("response/stream projection is reversed (to -> from)", () => {
    for (const phase of ["response", "stream"] as const) {
      const c = projectionContext(
        phase,
        "anthropic-messages",
        "openai-chat",
        anthropicDefaultProfile,
        openaiChatDefaultProfile,
      );
      expect(c.inputFormat).toBe("openai-chat");
      expect(c.outputFormat).toBe("anthropic-messages");
      expect(c.inputProfile).toBe(openaiChatDefaultProfile);
      expect(c.outputProfile).toBe(anthropicDefaultProfile);
    }
  });
});

describe("Stream block keys (P0-2/P1-5)", () => {
  it("distinguishes identical content indexes across choices", () => {
    expect(streamBlockKeyId(streamBlockKey(0, "text", 0))).not.toBe(
      streamBlockKeyId(streamBlockKey(1, "text", 0)),
    );
  });

  it("defaults choice to 0 for single-candidate streams", () => {
    expect(createStreamBlockKey("text", { content: 2 })).toEqual({
      choice: 0,
      kind: "text",
      content: 2,
    });
  });

  it("refuses to silently default a missing content index", () => {
    expect(() => createStreamBlockKey("tool", { choice: 1 })).toThrow();
  });

  it("supports the refusal block kind", () => {
    expect(createStreamBlockKey("refusal", { choice: 1, content: 0 }).kind).toBe(
      "refusal",
    );
  });
});

describe("Cache Metadata Accessor (P0-3/P1-1)", () => {
  it("reads the native anthropic cache_control on a part", () => {
    const part: ContentPart = {
      type: "text",
      text: "x",
      native: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    expect(getCacheControl(part)).toEqual({ type: "ephemeral" });
  });

  it("reads the native anthropic cache_control on a tool definition", () => {
    const tool: CanonicalTool = {
      name: "echo",
      inputSchema: { type: "object" },
      native: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    };
    expect(getCacheControl(tool)).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("returns undefined when no native cache is present", () => {
    expect(getCacheControl({ type: "text", text: "x" })).toBeUndefined();
  });
});

describe("Native field policies", () => {
  it("covers every Anthropic request field", () => {
    expect(Object.keys(ANTHROPIC_REQUEST_POLICY).sort()).toEqual(
      ["extra", "metadata", "outputConfig", "serviceTier", "topK"].sort(),
    );
  });

  it("resolves the value-dependent Chat n policy", () => {
    expect(resolve(CHAT_REQUEST_POLICY.n, ctx(1))).toBe("droppable");
    expect(resolve(CHAT_REQUEST_POLICY.n, ctx(2))).toBe("required");
    expect(resolve(CHAT_REQUEST_POLICY.n, ctx(undefined))).toBe("droppable");
  });

  it("marks retention/structure fields required", () => {
    expect(resolve(CHAT_REQUEST_POLICY.store, ctx(true))).toBe("required");
    expect(resolve(CHAT_REQUEST_POLICY.store, ctx(false))).toBe("droppable");
    expect(CHAT_REQUEST_POLICY.responseFormat).toBe("required");
  });
});

describe("Fidelity accounting (P1-3)", () => {
  const drop: DropRecord = {
    phase: "request",
    path: "native.anthropic.topK",
    sourceFormat: "anthropic-messages",
    targetFormat: "openai-chat",
    cause: "unsupported_by_target",
    authorization: "policy_droppable",
  };
  const adaptation = (lossy: boolean): FeatureAdaptationRecord => ({
    phase: "request",
    path: "cache",
    feature: "cache_affinity",
    lossy,
    sourceFormat: "anthropic-messages",
    targetFormat: "openai-chat",
  });

  it("is EXACT with no warnings/drops/adaptations", () => {
    expect(calculateFidelity([], [], [])).toBe("EXACT");
  });

  it("becomes LOSSY when a field is dropped", () => {
    expect(calculateFidelity([], [drop], [])).toBe("LOSSY");
  });

  it("never reports EXACT when a feature adaptation is present", () => {
    expect(calculateFidelity([], [], [adaptation(false)])).toBe("COMPATIBLE");
    expect(calculateFidelity([], [], [adaptation(true)])).toBe("LOSSY");
  });

  it("does not downgrade an UNSUPPORTED warning", () => {
    expect(
      calculateFidelity(
        [{ code: "x", message: "x", fidelity: "UNSUPPORTED" }],
        [drop],
        [],
      ),
    ).toBe("UNSUPPORTED");
  });
});
