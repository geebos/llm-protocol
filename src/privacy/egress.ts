/**
 * Policy-aware EgressVerify (PR-023, §7.6, docs/06 §12).
 *
 * Runs after every payload mutation and before `execute()`: the real target
 * payload is scanned for identified originals that survived outside a redacted
 * channel. Engine-generated placeholders are stripped first so an original
 * that is a substring of a placeholder never triggers a false positive
 * (PT-65). `policy` honours `allow` channels; `strict` overrides them.
 *
 * Placeholder-shaped literals are not rejected: only registered tokens can
 * restore, so an unregistered shape carries no value and forwarding it leaks
 * nothing. This removes the false rejections that made external text fail
 * closed (docs/06 §1.1).
 *
 * A failure lists the structural location and a MASKED form of the leaked
 * value (`1*********0`), so operators can locate the leak without the raw
 * value ever appearing in the diagnostic (INV-3).
 */
import type { ResolvedPrivacyConfig } from "./config.js";
import { guard } from "./errors.js";
import { createPlaceholderMatcher } from "./trie.js";
import type { PrivacySession } from "./session.js";

/** Maximum number of leaks listed in one egress error before truncating. */
const MAX_EGRESS_LEAKS = 10;

interface PayloadString {
  path: string;
  value: string;
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function collectStrings(value: unknown, out: PayloadString[], path: string): void {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, out, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    let i = 0;
    for (const [key, item] of Object.entries(value)) {
      // The key itself may carry the sensitive value, so its own path must not
      // embed it; child paths use the key name and are sanitized on output.
      out.push({ path: joinPath(path, `{key#${i}}`), value: key });
      collectStrings(item, out, joinPath(path, key));
      i++;
    }
  }
}

/** Remove registered placeholder occurrences so they cannot mask/emit hits. */
function stripRegistered(
  text: string,
  matcher: ReturnType<typeof createPlaceholderMatcher>,
): string {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const r = matcher.matchAt(text, pos, true);
    if (r.kind === "match") {
      pos = r.end;
      continue;
    }
    out += text[pos];
    pos++;
  }
  return out;
}

/**
 * Mask a leaked value for diagnostics: keep the first and last character and
 * star everything in between. Values of length <= 2 are fully masked. The raw
 * value is never emitted.
 */
function maskValue(value: string): string {
  if (value.length <= 2) return "*".repeat(value.length);
  return `${value[0]}${"*".repeat(value.length - 2)}${value[value.length - 1]}`;
}

/** Mask any known original that appears inside a diagnostic path. */
function sanitizePath(path: string, originals: string[], minLength: number): string {
  let out = path === "" ? "<root>" : path;
  for (const original of originals) {
    if (original.length < minLength) continue;
    if (out.includes(original)) out = out.split(original).join(maskValue(original));
  }
  return out;
}

/**
 * Verify the final outbound payload. Throws `PrivacyGuardError` when an
 * identified original survived outside a redacted channel.
 */
export function verifyEgress(
  payload: unknown,
  session: PrivacySession,
  config: ResolvedPrivacyConfig,
  allowTexts: string[],
): void {
  const entries = session.entries();
  if (entries.length === 0) return;
  const matcher = createPlaceholderMatcher(config.template, entries);
  const allowedOriginals = new Set<string>();
  if (config.egress === "policy") {
    for (const entry of entries) {
      if (entry.original.length < config.minEgressValueLength) continue;
      if (allowTexts.some((text) => text.includes(entry.original))) {
        allowedOriginals.add(entry.original);
      }
    }
  }

  const originals = entries.map((e) => e.original);
  const strings: PayloadString[] = [];
  collectStrings(payload, strings, "");

  const leaks: string[] = [];
  const seen = new Set<string>();
  for (const { path, value } of strings) {
    const stripped = stripRegistered(value, matcher);
    for (const entry of entries) {
      if (entry.original.length < config.minEgressValueLength) continue;
      if (!stripped.includes(entry.original)) continue;
      if (config.egress === "policy" && allowedOriginals.has(entry.original)) continue;
      const dedupe = `${path}\u0000${entry.type}\u0000${entry.original}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const safePath = sanitizePath(path, originals, config.minEgressValueLength);
      leaks.push(`${safePath} (${entry.type}: ${maskValue(entry.original)})`);
    }
  }

  if (leaks.length) {
    const shown = leaks.slice(0, MAX_EGRESS_LEAKS);
    const more = leaks.length > shown.length ? `; +${leaks.length - shown.length} more` : "";
    guard(
      "privacy_uncovered_channel",
      `A privacy-identified value survived into the outbound payload at ${shown.join("; ")}${more}`,
    );
  }
}
