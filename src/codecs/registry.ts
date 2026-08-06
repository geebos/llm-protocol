/**
 * Adapter registry (9.8). `openai-responses` is P1 scope and rejected here.
 */
import type { ApiFormat } from "../formats.js";
import { unsupportedError } from "../errors.js";
import type { ProtocolAdapter } from "./protocol-adapter.js";
import type { ProviderProfile } from "../capabilities/provider-profile.js";
import type { TranslationPolicies } from "../ir/policies.js";
import { createAnthropicAdapter } from "./anthropic-messages/index.js";
import { createOpenAiChatAdapter } from "./openai-chat/index.js";

const adapters: Record<
  ApiFormat,
  (profile?: ProviderProfile, policies?: TranslationPolicies) => ProtocolAdapter
> = {
  "anthropic-messages": createAnthropicAdapter,
  "openai-chat": createOpenAiChatAdapter,
  "openai-responses": () => {
    throw unsupportedError("openai-responses adapter is P1 scope, not implemented");
  },
};

export function getAdapter(
  format: ApiFormat,
  profile?: ProviderProfile,
  policies?: TranslationPolicies,
): ProtocolAdapter {
  return adapters[format](profile, policies);
}
