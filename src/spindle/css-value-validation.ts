/** The C0 controls disallowed in extension CSS values. HT, LF and CR remain valid CSS whitespace. */
export function hasProhibitedCssControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) return true;
  }
  return false;
}

const MAX_CSS_VALUE_LENGTH = 1024;
export function validateCssValue(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== "string") return "value must be a string";
  if (value.length > MAX_CSS_VALUE_LENGTH) return `value exceeds ${MAX_CSS_VALUE_LENGTH} characters`;
  if (value.length === 0) return null;
  const trimmed = value.trim(); const lowered = trimmed.toLowerCase().replace(/\\\\/g, "");
  if (hasProhibitedCssControl(value)) return "control characters not allowed";
  if (/[<>]/.test(value)) return "angle brackets not allowed";
  if (value.includes("{") || value.includes("}") || value.includes(";")) return "must be a single property value (no { } ; )";
  if (lowered.includes("javascript:")) return "javascript: URLs not allowed";
  if (lowered.includes("vbscript:")) return "vbscript: URLs not allowed";
  if (lowered.includes("data:text/html")) return "data:text/html URLs not allowed";
  if (lowered.includes("expression(")) return "CSS expression() not allowed";
  if (lowered.startsWith("@")) return "at-rules not allowed in variable values";
  if (/^url\(\s*['"]?\s*(?!https?:|data:image\/)/i.test(trimmed)) return "url() must point to https: or a data:image/* payload";
  if (/image-set\(/i.test(trimmed) && !/image-set\(\s*['"]?\s*(https?:|data:image\/)/i.test(trimmed)) return "image-set() must point to https: or a data:image/* payload";
  return null;
}
