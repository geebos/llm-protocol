/**
 * Privacy request-side runtime wiring (§3.2).
 *
 * Combines region collection, redaction, system notice injection and provides
 * the sanitized request trace. Kept separate from `translate()` so the
 * pipeline stays readable and the privacy decisions remain testable in
 * isolation.
 */
import type { CanonicalRequest, ContentPart } from "../ir/types.js";
import type { ResolvedPrivacyConfig } from "./config.js";
import {
  collectRequestRegions,
} from "./request.js";
import { redactRegions } from "./redact.js";
import { buildSystemNotice } from "./system.js";
import { buildExtensionProofs } from "./extension-verify.js";
import type { ExtensionPrivacyProof, PrivacyChannel, PrivacyWarning } from "./types.js";
import type { PrivacySession } from "./session.js";

export interface RequestPrivacyOutcome {
  redacted: number;
  escaped: number;
  invalidDetections: number;
  degraded: boolean;
  channels: PrivacyChannel[];
  allowTexts: string[];
  exemptTexts: string[];
  warnings: PrivacyWarning[];
  extensionProofs: ExtensionPrivacyProof[];
}

/** Redact every redactable channel of a canonical request in place. */
export async function redactCanonicalRequest(
  canonical: CanonicalRequest,
  config: ResolvedPrivacyConfig,
  session: PrivacySession,
): Promise<RequestPrivacyOutcome> {
  const { regions, extraHaystack, extensionsCoverage } = collectRequestRegions(
    canonical,
    config.coverage,
  );
  const result = await redactRegions(regions, session, config, extraHaystack);
  return {
    redacted: result.redacted,
    escaped: result.escaped,
    invalidDetections: result.invalidDetections,
    degraded: result.degraded,
    channels: [...result.channels] as PrivacyChannel[],
    allowTexts: result.allowTexts,
    exemptTexts: result.exemptTexts,
    warnings: result.warnings,
    extensionProofs: buildExtensionProofs(
      extensionsCoverage,
      result.transformedExtensions,
    ),
  };
}

/**
 * Inject the system privacy notice as an independent leading `system` message.
 * Runs after redaction so it never participates in recognition/collision. It is
 * placed after the existing leading system/developer segment (never modifying a
 * developer message) so the combined system prefix order is preserved (E-5).
 * Returns the injected text (or `undefined`) so the caller can exempt it.
 */
export function injectSystemNotice(
  canonical: CanonicalRequest,
  config: ResolvedPrivacyConfig,
): string | undefined {
  let leadingCount = 0;
  while (
    leadingCount < canonical.messages.length &&
    (canonical.messages[leadingCount].role === "system" ||
      canonical.messages[leadingCount].role === "developer")
  ) {
    leadingCount++;
  }
  const existing = canonical.messages
    .slice(0, leadingCount)
    .flatMap((m) => m.content)
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const notice = buildSystemNotice(config.system, config.template.raw, existing);
  if (!notice) return undefined;
  const injected = leadingCount > 0 ? `\n\n${notice}` : notice;
  canonical.messages.splice(leadingCount, 0, {
    role: "system",
    content: [{ type: "text", text: injected }],
  });
  return injected;
}
