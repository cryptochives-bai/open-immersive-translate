/** Input types whose content is free text worth translating. */
const TEXT_INPUT_TYPES = new Set(["text", "search"]);
/** Autofill hints that mark credentials, one-time codes, and payment data. */
const SENSITIVE_AUTOCOMPLETE =
  /\b(?:current-password|new-password|one-time-code|cc-[a-z-]+)\b/i;

/** Never read or rewrite credential, one-time-code, payment, or non-text fields. */
export function isSensitiveField(field: Element): boolean {
  if (
    field instanceof HTMLInputElement &&
    !TEXT_INPUT_TYPES.has(field.type.toLowerCase())
  ) {
    return true;
  }
  return SENSITIVE_AUTOCOMPLETE.test(field.getAttribute("autocomplete") ?? "");
}
