/**
 * OpenAI Chat adapter.
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { ProtocolAdapter } from "../protocol-adapter.js";
import { openaiChatEndpoint } from "./endpoint.js";
import { createOpenAiChatHeaders } from "./headers.js";
import { createOpenAiChatRequestCodec } from "./request.js";
import { createOpenAiChatResponseCodec } from "./response.js";
import { openaiChatErrorCodec } from "./error.js";
import { createOpenAiChatStreamParser } from "../../streams/openai/parse.js";
import { createOpenAiChatStreamRenderer } from "../../streams/openai/render.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";

export const openaiChatDefaultProfile: ProviderProfile = {
  protocol: "openai-chat",
  capabilities: {
    tools: true,
    parallelTools: true,
    streaming: true,
    thinking: false,
  },
  defaultHeaders: {},
};

export function createOpenAiChatAdapter(
  profile: ProviderProfile = openaiChatDefaultProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): ProtocolAdapter {
  return {
    format: profile.protocol,
    endpoint: openaiChatEndpoint,
    headers: createOpenAiChatHeaders(profile),
    request: createOpenAiChatRequestCodec(profile, policies),
    response: createOpenAiChatResponseCodec(profile, policies),
    error: openaiChatErrorCodec,
    stream: {
      createParse: (report?: (warning: TranslationWarning) => void) =>
        createOpenAiChatStreamParser(profile, report),
      createRender: (report?: (warning: TranslationWarning) => void) =>
        createOpenAiChatStreamRenderer(profile, policies, report),
    },
  };
}
