/**
 * FR-001 protocol identifier tests.
 */
import { describe, expect, it } from "vitest";
import { API_FORMATS, isApiFormat } from "../src/formats.js";

describe("ApiFormat", () => {
  it("covers the three documented formats", () => {
    expect(API_FORMATS).toContain("openai-chat");
    expect(API_FORMATS).toContain("anthropic-messages");
    expect(API_FORMATS).toContain("openai-responses");
  });

  it("validates legal formats", () => {
    expect(isApiFormat("openai-chat")).toBe(true);
    expect(isApiFormat("anthropic-messages")).toBe(true);
    expect(isApiFormat("openai-responses")).toBe(true);
  });

  it("rejects illegal formats", () => {
    expect(isApiFormat("openai")).toBe(false);
    expect(isApiFormat("claude")).toBe(false);
    expect(isApiFormat("")).toBe(false);
    expect(isApiFormat(null)).toBe(false);
    expect(isApiFormat(42)).toBe(false);
  });
});
