/**
 * Anthropic `cache_control` -> stable cache identity (Sub2API-style).
 *
 * Extracts the ephemeral text anchors from a raw Anthropic Messages body and
 * derives a deterministic `anthropic-cache-<32hex>` key. The extraction is
 * intentionally narrow (Sub2API anchor filter): only `type: "text"` blocks
 * with `cache_control.type === "ephemeral"` and non-empty trimmed text anchor
 * the key. Images, tool_use/tool_result, thinking and empty/invalid cache
 * blocks are ignored, so provider-specific JSON differences never change the
 * identity of the same semantic prompt.
 *
 * Seed order mirrors Sub2API: system anchors (in order), then all assistant
 * anchors (conversation order), then the *first* cached user block at the end.
 * Appending later conversation turns therefore never changes the key; changing
 * any anchored text does.
 */
import { createHash } from "node:crypto";
import type { CacheAffinity, CacheAnchor } from "../types.js";
import type { CacheAffinityResolver } from "../resolver.js";
import type { CanonicalRequest } from "../../ir/types.js";

const EPHEMERAL = "ephemeral";
const KEY_PREFIX = "anthropic-cache-";

/** Strict Sub2API anchor check: type ephemeral, optional string ttl. */
export function isEphemeralCacheControl(
  value: unknown,
): value is { type: "ephemeral"; ttl?: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; ttl?: unknown };
  if (v.type !== EPHEMERAL) return false;
  if (v.ttl !== undefined && typeof v.ttl !== "string") return false;
  return true;
}

function toAnchor(block: unknown, location: CacheAnchor["location"]): CacheAnchor | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as { type?: unknown; text?: unknown; cache_control?: unknown };
  if (b.type !== "text") return undefined;
  if (!isEphemeralCacheControl(b.cache_control)) return undefined;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (text === "") return undefined;
  return {
    location,
    text,
    cacheControl: b.cache_control,
  };
}

/**
 * Extract ephemeral cache anchors from a raw Anthropic Messages body.
 * Returns them in seed order: [system..., assistant..., firstUser?].
 */
export function extractAnthropicCacheAnchors(body: unknown): CacheAnchor[] {
  if (!body || typeof body !== "object") return [];
  const p = body as { system?: unknown; messages?: unknown };
  const system: CacheAnchor[] = [];
  if (Array.isArray(p.system)) {
    for (const block of p.system) {
      const a = toAnchor(block, "system");
      if (a) system.push(a);
    }
  }

  const assistant: CacheAnchor[] = [];
  let firstUser: CacheAnchor | undefined;
  if (Array.isArray(p.messages)) {
    p.messages.forEach((message, messageIndex) => {
      const m = message as { role?: unknown; content?: unknown } | null | undefined;
      if (!m || typeof m !== "object") return;
      if (m.role !== "user" && m.role !== "assistant") return;
      if (!Array.isArray(m.content)) return;
      m.content.forEach((part, contentIndex) => {
        if (!part || typeof part !== "object") return;
        const b = part as { type?: unknown; text?: unknown; cache_control?: unknown };
        if (b.type !== "text" || !isEphemeralCacheControl(b.cache_control)) return;
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (text === "") return;
        const anchor: CacheAnchor = {
          location: m.role === "assistant" ? "assistant" : "user",
          text,
          cacheControl: b.cache_control,
          messageIndex,
          contentIndex,
        };
        if (m.role === "assistant") {
          assistant.push(anchor);
        } else if (!firstUser) {
          firstUser = anchor;
        }
      });
    });
  }

  return [...system, ...assistant, ...(firstUser ? [firstUser] : [])];
}

/**
 * Role label used in the key seed. `user_anchor:` (not `user:`) and system /
 * assistant prefixes follow the Sub2API seed shape so different roles with the
 * same text never collide.
 */
function anchorSeed(anchor: CacheAnchor): string {
  const label = anchor.location === "user" ? "user_anchor" : anchor.location;
  return `${label}:${anchor.text}`;
}

/**
 * Deterministic cache key from anchors (Sub2API §12):
 * SHA-256 of `"anthropic-cache:" + seeds joined by "\n"`, first 16 bytes
 * rendered as 32 hex chars. TTL never participates in the identity.
 */
export function deriveAnthropicCacheKey(anchors: CacheAnchor[]): string | undefined {
  if (anchors.length === 0) return undefined;
  const seed = "anthropic-cache:" + anchors.map(anchorSeed).join("\n");
  const digest = createHash("sha256")
    .update(seed)
    .digest()
    .subarray(0, 16)
    .toString("hex");
  return `${KEY_PREFIX}${digest}`;
}

/**
 * Cache resolver backed by Anthropic `cache_control` anchors. Returns no
 * affinity when the body carries no valid ephemeral text anchor.
 */
export function anthropicCacheControlResolver(): CacheAffinityResolver {
  return {
    async resolve(
      _request: Request,
      sourceBody: unknown,
      _canonical: CanonicalRequest,
    ): Promise<CacheAffinity | undefined> {
      const anchors = extractAnthropicCacheAnchors(sourceBody);
      const key = deriveAnthropicCacheKey(anchors);
      if (!key) return undefined;
      return {
        key,
        source: "anthropic-cache-control",
        anchors,
        // Approximation: cache affinity, not lossless breakpoint semantics.
        lossy: true,
      };
    },
  };
}
