/**
 * Test-only bridge over the new `translate.<source>.<target>` entry.
 *
 * The M1-M5 suites were written against the old `translate({ from, to })`
 * factory + WHATWG `Request` ergonomics. Instead of rewriting every call site,
 * this helper extracts `url`/`headers`/`body` from the `Request` and delegates
 * to the new public namespace API. New tests should call
 * `translate.<source>.<target>(options)` directly.
 */
import { translate as api } from "../../src/index.js";
import type { ApiFormat, TranslateOptions } from "../../src/index.js";

const KEY = {
  "anthropic-messages": "messages",
  "openai-chat": "chat",
  "openai-responses": "responses",
} as const;

type BridgeOptions = Omit<TranslateOptions, "url" | "body" | "headers"> & {
  from: ApiFormat;
  to: ApiFormat;
};

export function translate(options: BridgeOptions): (request: Request) => Promise<Response> {
  const { from, to, ...rest } = options;
  const call = api[KEY[from]][KEY[to]];
  return async (request: Request): Promise<Response> => {
    const text = await request.text();
    // Hand invalid JSON through as-is so the core reports a validation error
    // instead of the bridge throwing a SyntaxError.
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return call({
      ...(rest as TranslateOptions),
      url: request.url,
      headers: request.headers,
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  };
}
