/**
 * Native-partition privacy coverage (docs/07 §8.2.4/§8.5, plan step 2).
 *
 * Native fields must be covered like extensions: default `allow` feeds the
 * collision/egress haystack; `redact` rewrites them in place; non-allow paths
 * join the covered set for the double-evidence check.
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
      const i = text.indexOf(PHONE);
      return i < 0 ? [] : [{ start: i, end: i + PHONE.length, type: "phone" }];
    },
  };
}

function requestWithMetadata(): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    native: { anthropic: { metadata: { note: `owner ${PHONE}` } } },
  };
}

describe("native partition coverage", () => {
  it("defaults to allow: native strings join the collision haystack", () => {
    const config = resolvePrivacyConfig({ recognizers: [phoneRecognizer()] });
    const canonical = requestWithMetadata();
    const { regions, extraHaystack, extensionsCoverage } = collectRequestRegions(
      canonical,
      config.coverage,
    );
    expect(regions.some((r) => r.path === "native.anthropic.metadata")).toBe(false);
    expect(extensionsCoverage).toHaveLength(0);
    expect(extraHaystack).toContain(`owner ${PHONE}`);
  });

  it("redacts a configured native field in place", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [phoneRecognizer()],
      coverage: { native: { "anthropic.metadata": "redact" } },
    });
    const canonical = requestWithMetadata();
    const { regions, extraHaystack, extensionsCoverage } = collectRequestRegions(
      canonical,
      config.coverage,
    );
    expect(extensionsCoverage).toContainEqual({
      path: "native.anthropic.metadata",
      action: "redact",
    });
    const region = regions.find((r) => r.path === "native.anthropic.metadata");
    expect(region?.channel).toBe("native");

    const session = new PrivacySession("native-test", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    const result = await redactRegions(regions, session, config, extraHaystack);
    expect(result.redacted).toBe(1);
    const metadata = canonical.native?.anthropic?.metadata as { note: string };
    expect(metadata.note).not.toContain(PHONE);
    expect(metadata.note).toContain("<private_placeholder_");
  });

  it("rejects a sensitive value in a configured reject native field", async () => {
    const config = resolvePrivacyConfig({
      recognizers: [phoneRecognizer()],
      coverage: { native: { "anthropic.metadata": "reject" } },
    });
    const canonical = requestWithMetadata();
    const { regions, extraHaystack } = collectRequestRegions(canonical, config.coverage);
    const session = new PrivacySession("native-test", {
      compiled: config.template,
      tagMode: config.tagMode,
      tagBytes: config.tagBytes,
      namespace: config.namespace,
    });
    await expect(redactRegions(regions, session, config, extraHaystack)).rejects.toMatchObject({
      code: "privacy_uncovered_channel",
    });
  });
});
