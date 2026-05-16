import { Tokenizer } from 'marked'
import type { Tokens } from 'marked'

const STRICT_DOUBLE_TILDE_DEL_RE = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/

export function createStrictTildeTokenizer() {
  const tokenizer = new Tokenizer()

  tokenizer.code = function (): Tokens.Code | undefined {
    return undefined
  }

  tokenizer.del = function (src: string): Tokens.Del | undefined {
    const cap = STRICT_DOUBLE_TILDE_DEL_RE.exec(src)
    if (!cap) return

    const text = cap[1]

    return {
      type: 'del',
      raw: cap[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    }
  }

  return tokenizer
}
