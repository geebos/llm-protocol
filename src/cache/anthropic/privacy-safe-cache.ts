/**
 * Privacy-safe Anthropic `cache_control` -> cache identity resolver (PR-021/025).
 *
 * Unlike the legacy resolver — which reads the raw source body — this resolver
 * only reads the *redacted* canonical request, so the cache identity is
 * derived from what actually leaves the gateway. The identity is an HMAC
 * digest over the tenant key, so the outbound digest never exposes an
 * enumerable hash of the raw anchor text (PT-57/PT-58).
 */
import { createHmac } from "node:crypto";
import type { CanonicalRequest } from "../../ir/types.js";
import type { CacheAffinity, CacheAnchor } from "../types.js";
import type { PrivacySafeCacheAffinityResolver } from "../resolver.js";

const KEY_PREFIX = "anthropic-cache-";
const DOMAIN = "llm-protocol-cache-affinity-v1";

export interface PrivacySafeCacheOptions {
  key: () => Uint8Array | Promise<Uint8Array>;
  namespace?: string;
}

/** Extract ephemeral anchors from the redacted canonical request. */
export function extractCanonicalCacheAnchors(
  canonical: CanonicalRequest,
): CacheAnchor[] {
  const system: CacheAnchor[] = [];
  for (const part of canonical.system ?? []) {
    if (part.type === "text" && part.cache) {
      system.push({
        location: "system",
        text: part.text,
        cacheControl: part.cache,
      });
    }
  }

  const assistant: CacheAnchor[] = [];
  let firstUser: CacheAnchor | undefined;
  canonical.messages.forEach((message, messageIndex) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    message.content.forEach((part, contentIndex) => {
      if (part.type !== "text" || !part.cache) return;
      const anchor: CacheAnchor = {
        location: message.role === "assistant" ? "assistant" : "user",
        text: part.text,
        cacheControl: part.cache,
        messageIndex,
        contentIndex,
      };
      if (message.role === "assistant") assistant.push(anchor);
      else if (!firstUser) firstUser = anchor;
    });
  });
  return [...system, ...assistant, ...(firstUser ? [firstUser] : [])];
}

function anchorSeed(anchor: CacheAnchor): string {
  const label = anchor.location === "user" ? "user_anchor" : anchor.location;
  return `${label}:${anchor.text}`;
}

/** HMAC-SHA256 digest (first 16 bytes hex) over the redacted anchors. */
export function derivePrivacySafeCacheKey(
  key: Uint8Array,
  namespace: string,
  anchors: CacheAnchor[],
): string | undefined {
  if (anchors.length === 0) return undefined;
  const seed = anchors.map(anchorSeed).join("\n");
  const hmac = createHmac("sha256", key);
  hmac.update(DOMAIN, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(namespace, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(seed, "utf8");
  const digest = hmac.digest().subarray(0, 16).toString("hex");
  return `${KEY_PREFIX}${digest}`;
}

export function createAnthropicPrivacySafeCacheResolver(
  options: PrivacySafeCacheOptions,
): PrivacySafeCacheAffinityResolver {
  return {
    async resolve(canonical: CanonicalRequest): Promise<CacheAffinity | undefined> {
      const anchors = extractCanonicalCacheAnchors(canonical);
      if (!anchors.length) return undefined;
      const key = await options.key();
      const derived = derivePrivacySafeCacheKey(key, options.namespace ?? "", anchors);
      if (!derived) return undefined;
      return {
        key: derived,
        source: "anthropic-cache-control",
        anchors,
        lossy: true,
      };
    },
  };
}
