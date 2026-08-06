/**
 * OpenAI Chat header codec (9.5).
 *
 * - Source: `Authorization: Bearer`.
 * - Target: `Authorization: Bearer`.
 * - No protocol-mandated extra headers.
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type {
  CanonicalCredential,
  HeaderCodec,
} from "../protocol-adapter.js";
import { parseBearer, sanitizeSourceHeaders } from "../headers.js";

export function createOpenAiChatHeaders(
  profile: ProviderProfile,
): HeaderCodec {
  return {
    parseCredential(headers: Headers): CanonicalCredential | undefined {
      const bearer = parseBearer(headers.get("authorization"));
      if (bearer) return { kind: "bearer", value: bearer };
      const apiKey = headers.get("x-api-key");
      if (apiKey) return { kind: "api-key", value: apiKey };
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
      if (credential) out.set("authorization", `Bearer ${credential.value}`);
      out.set("content-type", "application/json");
      return out;
    },
  };
}
