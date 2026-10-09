/**
 * Extension forwarding evidence (PR-014, §7.5).
 *
 * A codec reports which extension fields it rendered and their kind, so the
 * privacy layer can cross-check that a field it redacted was actually
 * forwarded (and that a field it rejected was not).
 */
import type { CodecContext } from "./protocol-adapter.js";
import type { RenderedExtensionDisposition } from "../privacy/types.js";

export type ExtensionKind = RenderedExtensionDisposition["kind"];

/** Classify an extension value: strings -> text, opaque keys -> opaque. */
export function extensionKind(key: string, value: unknown): ExtensionKind {
  if (/signature|encrypted/i.test(key)) return "opaque";
  if (containsString(value)) return "text";
  return "non-text";
}

function containsString(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(containsString);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsString);
  }
  return false;
}

/** Record one extension disposition (path/fieldId default to `extensions.<key>`). */
export function recordExtensionDisposition(
  ctx: CodecContext,
  key: string,
  value: unknown,
  forwarded: boolean,
  path = `extensions.${key}`,
): void {
  const dispositions = (ctx.extensionDispositions ??= []);
  dispositions.push({
    path,
    kind: extensionKind(key, value),
    forwarded,
    fieldId: path,
  });
}
