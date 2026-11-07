/**
 * Built-in request patches and the patch contract.
 *
 * Patches are opt-in: nothing here runs unless a caller passes it in
 * `TranslateOptions.patches`.
 */
export type { RequestPatch } from "./request-patch.js";
export {
  deepseekImageThinkingPatch,
  IMAGE_THINKING_PLACEHOLDER,
} from "./deepseek-image-thinking.js";
