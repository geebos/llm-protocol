/**
 * Anthropic Messages adapter.
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { ProtocolAdapter } from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { anthropicEndpoint } from "./endpoint.js";
import { createAnthropicHeaders } from "./headers.js";
import { anthropicRequestCodec } from "./request.js";
import { anthropicResponseCodec } from "./response.js";
import { anthropicErrorCodec } from "./error.js";
import { createAnthropicStreamParser } from "../../streams/anthropic/parse.js";
import { createAnthropicStreamRenderer } from "../../streams/anthropic/render.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import { normalizeAnthropicTurns } from "./normalize.js";

export { normalizeAnthropicTurns };

export const anthropicDefaultProfile: ProviderProfile = {
  protocol: "anthropic-messages",
  capabilities: {
    tools: true,
    parallelTools: true,
    streaming: true,
    thinking: true,
  },
  defaultHeaders: { "anthropic-version": "2023-06-01" },
};

export function createAnthropicAdapter(
  profile: ProviderProfile = anthropicDefaultProfile,
  _policies?: TranslationPolicies,
): ProtocolAdapter {
  return {
    format: profile.protocol,
    endpoint: anthropicEndpoint,
    headers: createAnthropicHeaders(profile),
    request: anthropicRequestCodec,
    response: anthropicResponseCodec,
    error: anthropicErrorCodec,
    stream: {
      createParse: (report?: (warning: TranslationWarning) => void) =>
        createAnthropicStreamParser(report),
      createRender: (report?: (warning: TranslationWarning) => void) =>
        createAnthropicStreamRenderer(report),
    },
  };
}
