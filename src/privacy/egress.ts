/**
 * Policy-aware EgressVerify (PR-023, §7.6).
 *
 * Runs after every payload mutation and before `execute()`: the real target
 * payload is scanned for identified originals that survived outside a redacted
 * channel. Engine-generated placeholders are stripped first so an original
 * that is a substring of a placeholder never triggers a false positive
 * (PT-65). `policy` honours `allow` channels; `strict` overrides them.
 */
import type { ResolvedPrivacyConfig } from "./config.js";
import { guard } from "./errors.js";
import { scanTemplateShape } from "./template.js";
import { createPlaceholderMatcher } from "./trie.js";
import type { PrivacySession } from "./session.js";

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
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
 * Verify the final outbound payload. Throws `PrivacyGuardError` on a leak or
 * an engine-unknown placeholder shape.
 */
export function verifyEgress(
  payload: unknown,
  session: PrivacySession,
  config: ResolvedPrivacyConfig,
  allowTexts: string[],
): void {
  const entries = session.snapshot();
  if (entries.length === 0) return;
  const placeholders = new Set(entries.map((e) => e.placeholder));
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

  const strings: string[] = [];
  collectStrings(payload, strings);

  for (const raw of strings) {
    const stripped = stripRegistered(raw, matcher);
    for (const entry of entries) {
      if (entry.original.length < config.minEgressValueLength) continue;
      if (!stripped.includes(entry.original)) continue;
      if (config.egress === "policy" && allowedOriginals.has(entry.original)) continue;
      guard(
        "privacy_uncovered_channel",
        "A privacy-identified value survived into the outbound payload",
      );
    }
    // A template-shaped literal that this engine did not generate is not
    // trusted: reject rather than forward it upstream.
    let idx = stripped.indexOf(config.template.prefix);
    while (idx !== -1) {
      const end = scanTemplateShape(config.template, stripped, idx);
      if (end !== undefined) {
        const shape = stripped.slice(idx, end);
        if (!placeholders.has(shape)) {
          guard(
            "privacy_unknown_placeholder",
            "An unrecognized placeholder shape reached the outbound payload",
          );
        }
      }
      idx = stripped.indexOf(config.template.prefix, idx + 1);
    }
  }
}
