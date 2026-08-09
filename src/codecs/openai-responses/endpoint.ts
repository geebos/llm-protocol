/**
 * OpenAI Responses endpoint codec (responses.md §17.1, D-5).
 */
import type {
  CanonicalEndpoint,
  EndpointCodec,
} from "../protocol-adapter.js";

const PATH = "/v1/responses";
const KIND = "responses" as const;

export const openaiResponsesEndpoint: EndpointCodec = {
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
