/**
 * Anthropic-native IR fields (docs/07.ir-native-codec.md §5).
 *
 * Typed protocol-specific fields carried through the Canonical IR so that
 * same-protocol conversion is lossless. Never an `unknown` blob: `extra` only
 * holds fields the schema does not yet name.
 */
import type { CanonicalCacheControl } from "../types.js";

export interface AnthropicNativeRequest {
  topK?: number;
  metadata?: Record<string, unknown>;
  serviceTier?: string;
  outputConfig?: Record<string, unknown>;
  /** Residual unknown fields (same-protocol preserve; cross-protocol default required). */
  extra?: Record<string, unknown>;
}

export interface AnthropicNativeMessage {
  /** Where the system message came from (top-level `system` vs inline messages). */
  origin?: "top_level_system" | "messages";
  extra?: Record<string, unknown>;
}

export interface AnthropicNativePart {
  /** Prompt-cache breakpoint on any block (migrated from `text.cache`). */
  cacheControl?: CanonicalCacheControl;
  /** Distinguishes `thinking` from `redacted_thinking` (replaces the providerMetadata hack). */
  thinkingKind?: "thinking" | "redacted_thinking";
  extra?: Record<string, unknown>;
}

export interface AnthropicNativeTool {
  /**
   * Server-tool `type` (e.g. `web_search_20250305`, `computer_20250124`).
   * Anthropic's implicit default `custom` is normalized away on parse, so an
   * absent `type` means a client-executed custom tool (§5.5 boundary).
   */
  type?: string;
  cacheControl?: CanonicalCacheControl;
  /**
   * Residual fields kept verbatim (same-protocol only). For server tools this
   * carries the provider-owned parameters (`max_uses`, `display_width_px`, ...).
   */
  extra?: Record<string, unknown>;
}

export interface AnthropicNativeResponse {
  stopSequence?: string | null;
  role?: string;
  extra?: Record<string, unknown>;
}

export interface AnthropicNativeChoice {
  extra?: Record<string, unknown>;
}

export interface AnthropicNativeStream {
  /** Native event/message type (e.g. redacted_thinking carrier). */
  messageType?: string;
  extra?: Record<string, unknown>;
}
