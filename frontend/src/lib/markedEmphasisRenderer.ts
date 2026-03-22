import { Renderer } from 'marked'
import type { RendererThis, Tokens } from 'marked'

interface EmphasisRendererOptions {
  emClass?: string
  strongClass?: string
  inlineEmphasisClass?: string
}

function wrapInlineTag(tag: 'em' | 'strong', className: string | undefined, inner: string): string {
  const classAttr = className ? ` class="${className}"` : ''
  return `<${tag}${classAttr}>${inner}</${tag}>`
}

export function createEmphasisAwareRenderer(options: EmphasisRendererOptions = {}) {
  const renderer = new Renderer()
  let emphasisDepth = 0

  renderer.em = function (this: RendererThis, token: Tokens.Em) {
    emphasisDepth += 1

    try {
      const inner = token.tokens ? this.parser.parseInline(token.tokens) : token.text

      if (emphasisDepth > 1) {
        return wrapInlineTag('strong', options.inlineEmphasisClass ?? options.strongClass, inner)
      }

      return wrapInlineTag('em', options.emClass, inner)
    } finally {
      emphasisDepth -= 1
    }
  }

  renderer.strong = function (this: RendererThis, token: Tokens.Strong) {
    const inner = token.tokens ? this.parser.parseInline(token.tokens) : token.text
    return wrapInlineTag('strong', options.strongClass, inner)
  }

  return renderer
}
