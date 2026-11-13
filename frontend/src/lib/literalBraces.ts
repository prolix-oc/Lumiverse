// Backend data sentinels stay shielded until the final display macro pass.
// Keep these tokens in sync with src/macros/literal-braces.ts.
const OPEN = '\x00LUMIVERSE_LITERAL_BRACE_OPEN_7f37c911\x00'
const CLOSE = '\x00LUMIVERSE_LITERAL_BRACE_CLOSE_7f37c911\x00'

export function restoreLiteralBraces(text: string): string {
  return text.replaceAll(OPEN, '{').replaceAll(CLOSE, '}')
}
