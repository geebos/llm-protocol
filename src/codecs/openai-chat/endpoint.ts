/**
 * OpenAI Chat Completions endpoint codec (9.4).
 */
import type {
  CanonicalEndpoint,
  EndpointCodec,
} from "../protocol-adapter.js";

const PATH = "/v1/chat/completions";
const KIND = "chat" as const;

export const openaiChatEndpoint: EndpointCodec = {
  matches(url: URL): boolean {
    return url.pathname === PATH;
  },

  toCanonical(url: URL): CanonicalEndpoint {
    return { kind: KIND, query: {} };
  },

  fromCanonical(_endpoint: CanonicalEndpoint, targetOrigin: URL): URL {
    const url = new URL(targetOrigin.origin);
    url.pathname = PATH;
    return url;
  },
};
