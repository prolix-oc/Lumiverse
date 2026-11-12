/** Delimiters understood by the chat renderer. Underline uses inline HTML. */
export const COMPOSER_FORMATS = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  quotes: ['"', '"'],
  singleQuotes: ["'", "'"],
  parentheses: ['(', ')'],
} as const

export type ComposerFormat = keyof typeof COMPOSER_FORMATS

export function formatComposerSelection(text: string, start: number, end: number, format: ComposerFormat) {
  const [open, close] = COMPOSER_FORMATS[format]
  const selected = text.slice(start, end)
  return {
    replacement: open + selected + close,
    text: text.slice(0, start) + open + selected + close + text.slice(end),
    start: start + open.length,
    end: end + open.length,
  }
}
