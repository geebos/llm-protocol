/**
 * Restore-scale regression (INV-16/INV-17).
 *
 * The hold-point scan must stay linear in the buffer length. A per-character
 * full-buffer rescan made restoring a 1 MB plain-text field take minutes and
 * pinned the host event loop. Guards are deliberately loose (an O(n) pass is
 * milliseconds) so CI jitter cannot flake them while a quadratic regression
 * still fails hard.
 */
import { describe, expect, it } from "vitest";
import { compileTemplate, restoreString } from "../../src/index.js";

const compiled = compileTemplate("<PP_{type}_{N}>");
const entries = [{ placeholder: "<PP_phone_1>", original: "13800138000" }];

const PLAIN_TEXT_GUARD_MS = 1000;

describe("restore scale (linear hold-point scan)", () => {
  it("restores 1 MB of plain text under a linear budget", () => {
    const text = "a".repeat(1024 * 1024);
    const t0 = performance.now();
    const result = restoreString(text, compiled, entries, 128);
    const elapsed = performance.now() - t0;
    expect(result.text).toBe(text);
    expect(elapsed).toBeLessThan(PLAIN_TEXT_GUARD_MS);
  });

  it("stays linear on prefix-dense input", () => {
    const text = "<PP_!".repeat(100_000);
    const t0 = performance.now();
    const result = restoreString(text, compiled, entries, 128);
    const elapsed = performance.now() - t0;
    expect(result.text).toBe(text);
    expect(elapsed).toBeLessThan(PLAIN_TEXT_GUARD_MS);
  });

  it("still restores registered placeholders", () => {
    expect(restoreString("a<PP_phone_1>b", compiled, entries, 128).text).toBe(
      "a13800138000b",
    );
  });

  it("still preserves a trailing partial placeholder", () => {
    expect(restoreString("x<PP_ph", compiled, entries, 128).text).toBe("x<PP_ph");
  });
});
