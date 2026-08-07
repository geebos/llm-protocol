/**
 * Cache affinity resolver pipeline.
 *
 * Resolvers run in priority order; the first one that yields a `key` wins
 * (explicit > generated). Composition lets a Gateway inject its own resolvers
 * (e.g. Claude Code metadata session, tenant-scoped digest prefix store)
 * without touching the protocol core.
 */
import type { CanonicalRequest } from "../ir/types.js";
import type { CacheAffinity } from "./types.js";
import { anthropicCacheControlResolver } from "./anthropic/cache-control.js";

export interface CacheAffinityResolver {
  resolve(
    request: Request,
    sourceBody: unknown,
    canonical: CanonicalRequest,
  ): Promise<CacheAffinity | undefined>;
}

/** Run resolvers in order; the first with a `key` wins. */
export async function resolveCacheAffinity(
  resolvers: CacheAffinityResolver[],
  request: Request,
  sourceBody: unknown,
  canonical: CanonicalRequest,
): Promise<CacheAffinity | undefined> {
  for (const resolver of resolvers) {
    const result = await resolver.resolve(request, sourceBody, canonical);
    if (result?.key) return result;
  }
  return undefined;
}

export function composeCacheResolvers(
  resolvers: CacheAffinityResolver[],
): CacheAffinityResolver {
  return {
    async resolve(request, sourceBody, canonical) {
      return resolveCacheAffinity(resolvers, request, sourceBody, canonical);
    },
  };
}

/**
 * Highest-priority resolver: an explicitly supplied cache identity. The core
 * never overrides a key the caller set, e.g. via an internal
 * `x-llm-prompt-cache-key` request header (the header is not forwarded to the
 * target — it is only consumed here).
 */
export function explicitCacheKeyResolver(
  header = "x-llm-prompt-cache-key",
): CacheAffinityResolver {
  return {
    async resolve(request: Request): Promise<CacheAffinity | undefined> {
      const key = request.headers.get(header);
      if (!key) return undefined;
      return { key, source: "explicit" };
    },
  };
}

/** Default chain for `translate({ cache: {} })`: explicit header, then anchors. */
export const DEFAULT_CACHE_RESOLVERS: CacheAffinityResolver[] = [
  explicitCacheKeyResolver(),
  anthropicCacheControlResolver(),
];
