/**
 * Anthropic Messages header codec (9.5).
 *
 * - Source: `x-api-key` (or `Authorization: Bearer`).
 * - Target: `x-api-key`, plus protocol-mandated `anthropic-version`.
 * - The credential value is moved, never logged or stored.
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type {
  CanonicalCredential,
  HeaderCodec,
} from "../protocol-adapter.js";
import { parseBearer, sanitizeSourceHeaders } from "../headers.js";

export function createAnthropicHeaders(
  profile: ProviderProfile,
): HeaderCodec {
  return {
    parseCredential(headers: Headers): CanonicalCredential | undefined {
      const apiKey = headers.get("x-api-key");
      if (apiKey) return { kind: "api-key", value: apiKey };
      const bearer = parseBearer(headers.get("authorization"));
      if (bearer) return { kind: "bearer", value: bearer };
      return undefined;
    },

    renderTargetHeaders(
      headers: Headers,
      credential: CanonicalCredential | undefined,
    ): Headers {
      const out = sanitizeSourceHeaders(headers);
      for (const [key, value] of Object.entries(profile.defaultHeaders)) {
        out.set(key, value);
      }
      if (credential) out.set("x-api-key", credential.value);
      out.set("content-type", "application/json");
      return out;
    },
  };
}
