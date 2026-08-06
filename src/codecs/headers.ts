/**
 * Shared header helpers (9.5).
 *
 * Hop-by-hop headers, cookies and credentials must never pass through between
 * protocols; only allowlisted tracing headers survive.
 */
import type { CanonicalCredential, HeaderCodec } from "./protocol-adapter.js";

/** Headers that must never be forwarded between protocols. */
const STRIP_HEADERS = [
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "host",
];

/** Tracing headers safe to preserve across the translation boundary. */
const ALLOWLIST = ["traceparent", "tracestate", "x-request-id"];

export function sanitizeSourceHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (STRIP_HEADERS.includes(key.toLowerCase())) return;
    if (!ALLOWLIST.includes(key.toLowerCase())) return;
    out.set(key, value);
  });
  return out;
}

/** Extract a Bearer token from an Authorization header. */
export function parseBearer(authorization: string | null): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1] : undefined;
}
