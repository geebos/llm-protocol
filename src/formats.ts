/**
 * Protocol format identifiers (FR-001).
 *
 * The canonical set of formats understood by the translation core. P0 ships
 * `openai-chat` and `anthropic-messages`; `openai-responses` is reserved for
 * P1 and rejected at adapter-selection time until implemented.
 */
export const API_FORMATS = [
  "openai-chat",
  "anthropic-messages",
  "openai-responses",
] as const;

export type ApiFormat = (typeof API_FORMATS)[number];

export function isApiFormat(value: unknown): value is ApiFormat {
  return (
    typeof value === "string" &&
    (API_FORMATS as readonly string[]).includes(value)
  );
}
