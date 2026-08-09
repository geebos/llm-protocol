/**
 * OpenAI Responses adapter.
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { ProtocolAdapter } from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import { openaiResponsesEndpoint } from "./endpoint.js";
import { createOpenAiResponsesHeaders } from "./headers.js";
import { createOpenAiResponsesRequestCodec } from "./request.js";
import { openaiResponsesResponseCodec } from "./response.js";
import { openaiResponsesErrorCodec } from "./error.js";
import { createResponsesStreamParser } from "../../streams/responses/parse.js";
import { createResponsesStreamRenderer } from "../../streams/responses/render.js";

export const openaiResponsesDefaultProfile: ProviderProfile = {
  protocol: "openai-responses",
  capabilities: {
    tools: true,
    parallelTools: true,
    streaming: true,
    thinking: true,
    thinkingGeneration: {
      mode: "adaptive",
      effortLocation: "output_config",
      manualBudgetSupported: false,
      interleaving: true,
      requiresLeadingBlock: false,
    },
    responses: {
      conversationState: true,
      responseStorage: true,
      promptTemplates: false,
      customTools: true,
      namespaceTools: true,
      structuredOutput: true,
      reasoningText: true,
      carrierMode: "native",
      terminalEvents: { queued: true, cancelled: true },
      contextTruncation: { auto: true },
      identity: { endUserTracking: { legacy: true, safety: true } },
      serverSideTools: true,
    },
  },
  defaultHeaders: {},
};

export function createOpenAiResponsesAdapter(
  profile: ProviderProfile = openaiResponsesDefaultProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): ProtocolAdapter {
  return {
    format: profile.protocol,
    profile,
    endpoint: openaiResponsesEndpoint,
    headers: createOpenAiResponsesHeaders(profile),
    request: createOpenAiResponsesRequestCodec(profile, policies),
    response: openaiResponsesResponseCodec,
    error: openaiResponsesErrorCodec,
    stream: {
      createParse: (report?: (warning: TranslationWarning) => void) =>
        createResponsesStreamParser(profile, report),
      createRender: (report?: (warning: TranslationWarning) => void) =>
        createResponsesStreamRenderer(profile, report),
    },
  };
}
