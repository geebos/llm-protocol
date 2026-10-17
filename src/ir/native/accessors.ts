/**
 * Unified Cache Metadata Accessor (docs/07.ir-native-codec.md §5.6.1, DEC-14).
 *
 * All cache-breakpoint reads must go through this accessor so Cache and Privacy
 * never implement divergent breakpoint detection. Covers both content blocks and
 * tool definitions (`CanonicalTool` is not a `ContentPart`).
 */
import type { ContentPart, CanonicalCacheControl, CanonicalTool } from "../types.js";

export function getCacheControl(value: ContentPart): CanonicalCacheControl | undefined;
export function getCacheControl(value: CanonicalTool): CanonicalCacheControl | undefined;
export function getCacheControl(
  value: ContentPart | CanonicalTool,
): CanonicalCacheControl | undefined {
  return value.native?.anthropic?.cacheControl;
}
