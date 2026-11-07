/**
 * Request patch contract.
 *
 * Patches are opt-in: nothing runs unless a caller passes it in
 * `TranslateOptions.patches`. Provider-specific patches belong in the caller,
 * not in this package.
 */
export type { RequestPatch } from "./request-patch.js";
