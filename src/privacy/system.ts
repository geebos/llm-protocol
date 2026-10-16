/**
 * System notice injection (PR-015, §7.8).
 *
 * The notice is appended AFTER redaction and collision scanning, as its own
 * text part, and never participates in recognition, collision or restore. It
 * is trusted configuration and must not embed unprocessed private data.
 */

/** Default system notice; `{template}` is substituted on injection. */
export const DEFAULT_SYSTEM_NOTICE = [
  "Privacy notice: some values in this conversation may be replaced by placeholders of the form {template}.",
  "Treat every placeholder as ordinary characters, not as content to interpret:",
  "- Reproduce placeholders exactly as written; never rewrite, translate, split, or invent placeholders.",
  "- Do not guess, infer, or derive what a placeholder stands for, and never attempt to restore it in any form.",
  "- Trust that placeholder replacement is correct and will not cause errors; if something looks wrong, investigate other causes instead of questioning or reverting a placeholder.",
  "- You may reference a placeholder in your answer when useful; it will be restored for the end user automatically.",
].join("\n");

/**
 * Build the notice text, or `undefined` when disabled or already present.
 */
export function buildSystemNotice(
  system: string | false,
  template: string,
  existingSystemText: string,
): string | undefined {
  if (system === false) return undefined;
  const notice = (system === "default" ? DEFAULT_SYSTEM_NOTICE : system).replace(
    "{template}",
    template,
  );
  if (existingSystemText.includes(notice)) return undefined;
  return notice;
}
