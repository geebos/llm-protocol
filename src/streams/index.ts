/**
 * Streaming module exports (M2).
 */
export { createSSEParser, encodeSSE, encodeDataFrame } from "./sse-parser.js";
export type { SSEFrame } from "./sse-parser.js";
export { createCanonicalValidator } from "./validator.js";
export type { CanonicalStreamEvent } from "./types.js";
export { createAnthropicStreamParser } from "./anthropic/parse.js";
export { createAnthropicStreamRenderer, withAnthropicKeepAlive } from "./anthropic/render.js";
export { createOpenAiChatStreamParser } from "./openai/parse.js";
export { createOpenAiChatStreamRenderer } from "./openai/render.js";
