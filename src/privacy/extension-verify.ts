/**
 * Extension double-evidence cross-check (PR-014, §7.5).
 *
 * Evidence 1 is the codec's forwarding report; evidence 2 is the privacy
 * layer's proof of how each covered extension field was handled. A covered
 * field must appear in the forwarding report with a consistent disposition,
 * opaque paths may only be rejected, a rejected field must not be forwarded,
 * and an inspected/transformed field must be forwarded. Any inconsistency is
 * fail-closed.
 */
import { guard } from "./errors.js";
import type { ExtensionPrivacyProof, RenderedExtensionDisposition } from "./types.js";

/** Build privacy proofs from covered paths and the set of transformed paths. */
export function buildExtensionProofs(
  coverage: { path: string; action: "redact" | "reject" }[],
  transformed: string[],
): ExtensionPrivacyProof[] {
  const transformedSet = new Set(transformed);
  return coverage.map((entry) => ({
    path: entry.path,
    fieldId: entry.path,
    status:
      entry.action === "reject"
        ? "rejected"
        : transformedSet.has(entry.path)
          ? "transformed"
          : "inspected",
  }));
}

export function verifyExtensions(
  supportsReport: boolean,
  dispositions: RenderedExtensionDisposition[] | undefined,
  proofs: ExtensionPrivacyProof[],
): void {
  if (proofs.length === 0) return;
  if (!supportsReport) {
    guard(
      "privacy_extension_unverifiable",
      "The target codec does not report extension forwarding evidence",
      "extensions",
    );
  }
  const byPath = new Map((dispositions ?? []).map((d) => [d.fieldId, d]));
  for (const proof of proofs) {
    const disposition = byPath.get(proof.fieldId);
    if (!disposition) {
      guard(
        "privacy_extension_unverifiable",
        "No forwarding evidence for a covered extension field",
        proof.path,
      );
    }
    if (disposition.kind === "opaque" && proof.status !== "rejected") {
      guard(
        "privacy_extension_unverifiable",
        "Opaque extension fields may only be rejected",
        proof.path,
      );
    }
    if (proof.status === "rejected" && disposition.forwarded) {
      guard(
        "privacy_extension_unverifiable",
        "A rejected extension field was forwarded",
        proof.path,
      );
    }
    if (proof.status !== "rejected" && !disposition.forwarded) {
      guard(
        "privacy_extension_unverifiable",
        "A covered extension field was not forwarded as expected",
        proof.path,
      );
    }
  }
}
