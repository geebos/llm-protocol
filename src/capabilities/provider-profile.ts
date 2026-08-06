/**
 * Capability model (FR-007).
 *
 * Mapping decisions are driven by declared capabilities, never by guessing
 * from model names. The default profiles correspond to the official protocol
 * surface; compatible providers may declare narrower or wider capabilities.
 */
import type { ApiFormat } from "../formats.js";

export interface ProviderCapabilities {
  tools: boolean;
  parallelTools: boolean;
  streaming: boolean;
  thinking: boolean;
  /** Provider-specific reasoning field name in Chat responses (TH-003). */
  reasoningField?: string;
}

export interface ProviderProfile {
  protocol: ApiFormat;
  capabilities: ProviderCapabilities;
  /** Protocol-mandated default headers (e.g. `anthropic-version`). */
  defaultHeaders: Record<string, string>;
}
