/**
 * Failure phase taxonomy (docs/07.ir-native-codec.md §6.4, R-24).
 *
 * Lets Trace/Completion state the layer a failure happened in and whether any
 * output had already been committed to the client.
 */
export type TranslationFailurePhase =
  | "parse"
  | "privacy"
  | "projection"
  | "render"
  | "upstream";
