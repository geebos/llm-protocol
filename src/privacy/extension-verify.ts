/**
 * Extension double-evidence cross-check (PR-014, §7.5).
 *
 * Evidence 1 is the codec's forwarding report; evidence 2 is the privacy
 * layer's handling report. A covered field must appear in the forwarding
 * report with a matching disposition, opaque paths may only be rejected, a
 * rejected field must not be forwarded, and a redacted field must be
 * forwarded. Any inconsistency is fail-closed.
 */
import { guard } from "./errors.js";
import type { RenderedExtensionDisposition } from "./types.js";

export interface ExtensionCoverageEntry {
  path: string;
  action: "redact" | "reject";
}

export function verifyExtensions(
  supportsReport: boolean,
  dispositions: RenderedExtensionDisposition[] | undefined,
  coverage: ExtensionCoverageEntry[],
  _transformed: string[],
): void {
  if (coverage.length === 0) return;
  if (!supportsReport) {
    guard(
      "privacy_extension_unverifiable",
      "The target codec does not report extension forwarding evidence",
      "extensions",
    );
  }
  const byPath = new Map((dispositions ?? []).map((d) => [d.path, d]));
  for (const entry of coverage) {
    const disposition = byPath.get(entry.path);
    if (!disposition) {
      guard(
        "privacy_extension_unverifiable",
        "No forwarding evidence for a covered extension field",
        entry.path,
      );
    }
    if (disposition.kind === "opaque" && entry.action !== "reject") {
      guard(
        "privacy_extension_unverifiable",
        "Opaque extension fields may only be rejected",
        entry.path,
      );
    }
    if (entry.action === "reject" && disposition.forwarded) {
      guard(
        "privacy_extension_unverifiable",
        "A rejected extension field was forwarded",
        entry.path,
      );
    }
    if (entry.action === "redact" && !disposition.forwarded) {
      guard(
        "privacy_extension_unverifiable",
        "A redacted extension field was not forwarded as expected",
        entry.path,
      );
    }
  }
}
