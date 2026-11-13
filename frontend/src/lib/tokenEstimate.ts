export const ESTIMATE_CHARS_PER_TOKEN = 4;

export type TokenizableContent = string | null | undefined;

export function estimateTokens(content: TokenizableContent): number {
  if (content == null) {
    return 0;
  }

  if (typeof content !== "string") {
    throw new TypeError("Tokenizable content must be a string, null, or undefined");
  }

  if (content.length === 0) {
    return 0;
  }

  return Math.ceil(content.length / ESTIMATE_CHARS_PER_TOKEN);
}
