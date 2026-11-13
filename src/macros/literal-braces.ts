import { ESCAPED_CLOSE, ESCAPED_OPEN } from "./MacroParser";

/**
 * Sentinels that stand in for `{` / `}` in text that must reach the model as
 * literal characters — the body of a `{{#escape}}...{{/escape}}` block.
 *
 * A literal `{{user}}` cannot be emitted by one macro pass and survive the
 * next: `evaluate()` re-parses its own output while it converges, and prompt
 * assembly evaluates preset content a second time
 * (`resolvePromptMacrosAfterRegexPass`) over the assembled messages. Both
 * passes would expand a real `{{user}}`. Emitting sentinels instead keeps the
 * body inert — the lexer only treats `{{` as a macro open — and the braces are
 * restored once no macro pass can run again (`restoreLiteralBraces`).
 *
 * These are deliberately NOT `ESCAPED_OPEN` / `ESCAPED_CLOSE`: `postprocess()`
 * converts those back to braces at the end of every `evaluate()` call, so they
 * cannot survive into a later pass.
 */
// These deliberately use long reserved tokens rather than single control
// characters. Ordinary text can legitimately contain ASCII ETX/EOT, and the
// final restoration pass must never reinterpret those bytes as braces.
export const LITERAL_BRACE_OPEN =
  "\x00LUMIVERSE_LITERAL_BRACE_OPEN_7f37c911\x00";
export const LITERAL_BRACE_CLOSE =
  "\x00LUMIVERSE_LITERAL_BRACE_CLOSE_7f37c911\x00";

/**
 * Replace every brace with its literal sentinel so later macro passes leave the
 * text alone. Escaped braces (`\{`) arrive here as ESCAPED_OPEN/CLOSE sentinels
 * and are shielded too, so `\{\{` inside a body cannot leak a real `{{` either.
 */
export function shieldLiteralBraces(text: string): string {
  if (!text.includes("{") && !text.includes("}") && !text.includes(ESCAPED_OPEN) && !text.includes(ESCAPED_CLOSE)) {
    return text;
  }
  return text
    .replaceAll("\\{", LITERAL_BRACE_OPEN)
    .replaceAll("\\}", LITERAL_BRACE_CLOSE)
    .replaceAll(ESCAPED_OPEN, LITERAL_BRACE_OPEN)
    .replaceAll(ESCAPED_CLOSE, LITERAL_BRACE_CLOSE)
    .replaceAll("{", LITERAL_BRACE_OPEN)
    .replaceAll("}", LITERAL_BRACE_CLOSE);
}

/**
 * Turn literal-brace sentinels back into the braces the model must receive.
 * Idempotent, and a no-op for text that carries no sentinel.
 */
export function restoreLiteralBraces(text: string): string {
  if (!text.includes(LITERAL_BRACE_OPEN) && !text.includes(LITERAL_BRACE_CLOSE)) return text;
  return text.replaceAll(LITERAL_BRACE_OPEN, "{").replaceAll(LITERAL_BRACE_CLOSE, "}");
}
