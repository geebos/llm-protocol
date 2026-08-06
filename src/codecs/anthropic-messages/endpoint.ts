/**
 * Anthropic Messages endpoint codec (9.4).
 */
import type {
  CanonicalEndpoint,
  EndpointCodec,
} from "../protocol-adapter.js";

const PATH = "/v1/messages";
const KIND = "messages" as const;

export const anthropicEndpoint: EndpointCodec = {
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
