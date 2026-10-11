/**
 * `translate.<source>.<target>` namespace (05.translate-api.md, Appendix A).
 *
 * Selectors are stateless and reusable; each call resolves the adapters and
 * runs one translation. `responses` combinations surface an `unsupported`
 * error until the adapter lands (P1).
 */
import type { ApiFormat } from "../formats.js";
import type {
  TranslateCall,
  TranslateNamespace,
  TranslateOptions,
  TranslateTargets,
} from "./types.js";
import { translateCall } from "./translate.js";

function build<From extends ApiFormat>(from: From) {
  const call = (to: ApiFormat) => (options: TranslateOptions) =>
    translateCall(from, to, options);
  const targets: TranslateTargets<From> = {
    messages: call("anthropic-messages"),
    chat: call("openai-chat"),
    responses: call("openai-responses"),
  };
  return targets;
}

export function buildTranslateNamespace(): TranslateNamespace {
  return {
    messages: build("anthropic-messages"),
    chat: build("openai-chat"),
    responses: build("openai-responses"),
  };
}

/** Public `translate` entry. */
export const translate: TranslateNamespace = buildTranslateNamespace();
