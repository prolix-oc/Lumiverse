/// <reference types="bun-types" />

import { afterAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
})

const originalWindow = (globalThis as any).window
const originalDocument = (globalThis as any).document
const originalDOMParser = (globalThis as any).DOMParser
const originalNode = (globalThis as any).Node
const originalDocumentFragment = (globalThis as any).DocumentFragment
const originalElement = (globalThis as any).Element
const originalHTMLElement = (globalThis as any).HTMLElement
const originalSVGElement = (globalThis as any).SVGElement
const originalShadowRoot = (globalThis as any).ShadowRoot

Object.assign(globalThis as any, {
  window: dom.window,
  document: dom.window.document,
  DOMParser: dom.window.DOMParser,
  Node: dom.window.Node,
  DocumentFragment: dom.window.DocumentFragment,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  ShadowRoot: dom.window.ShadowRoot,
})

const { sanitizeRichHtml, sanitizeHtmlIsland } = await import('./richHtmlSanitizer')

afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow

  if (originalDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = originalDocument

  if (originalDOMParser === undefined) delete (globalThis as any).DOMParser
  else (globalThis as any).DOMParser = originalDOMParser

  if (originalNode === undefined) delete (globalThis as any).Node
  else (globalThis as any).Node = originalNode

  if (originalDocumentFragment === undefined) delete (globalThis as any).DocumentFragment
  else (globalThis as any).DocumentFragment = originalDocumentFragment

  if (originalElement === undefined) delete (globalThis as any).Element
  else (globalThis as any).Element = originalElement

  if (originalHTMLElement === undefined) delete (globalThis as any).HTMLElement
  else (globalThis as any).HTMLElement = originalHTMLElement

  if (originalSVGElement === undefined) delete (globalThis as any).SVGElement
  else (globalThis as any).SVGElement = originalSVGElement

  if (originalShadowRoot === undefined) delete (globalThis as any).ShadowRoot
  else (globalThis as any).ShadowRoot = originalShadowRoot
})

function parseFragment(html: string): HTMLDivElement {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root || root.tagName !== 'DIV') throw new Error('Expected parsed wrapper root')
  return root as HTMLDivElement
}

describe('richHtmlSanitizer inline SVG support', () => {
  test('preserves safe inline svg in rich html', () => {
    const root = parseFragment(
      sanitizeRichHtml('<p>Before <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0L10 10"/></svg> after</p>'),
    )

    const svg = root.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M0 0L10 10')
  })

  test('keeps local svg refs and strips external resource refs', () => {
    const root = parseFragment(
      sanitizeRichHtml(
        [
          '<svg viewBox="0 0 10 10">',
          '  <defs>',
          '    <linearGradient id="grad"></linearGradient>',
          '    <symbol id="icon"><path d="M0 0L10 10"/></symbol>',
          '    <linearGradient id="remoteGrad" href="https://evil.test/g.svg#grad"></linearGradient>',
          '  </defs>',
          '  <use href="#icon"></use>',
          '  <use href="https://evil.test/x.svg#icon"></use>',
          '  <rect fill="url(#grad)" filter="url(https://evil.test/f.svg#blur)" style="mask: url(#mask); clip-path: url(https://evil.test/c.svg#clip); stroke: red;"></rect>',
          '</svg>',
        ].join(''),
      ),
    )

    const uses = root.querySelectorAll('use')
    expect(uses).toHaveLength(2)
    expect(uses[0]?.getAttribute('href')).toBe('#icon')
    expect(uses[1]?.hasAttribute('href')).toBe(false)

    const remoteGradient = root.querySelector('linearGradient[id="remoteGrad"]')
    expect(remoteGradient?.hasAttribute('href')).toBe(false)

    const rect = root.querySelector('rect')
    expect(rect?.getAttribute('fill')).toBe('url(#grad)')
    expect(rect?.hasAttribute('filter')).toBe(false)
    expect(rect?.getAttribute('style')).toContain('mask: url(#mask)')
    expect(rect?.getAttribute('style')).toContain('stroke: red')
    expect(rect?.getAttribute('style') ?? '').not.toContain('https://evil.test')
  })

  test('removes active content and image-loading tags from inline svg', () => {
    const root = parseFragment(
      sanitizeRichHtml(
        '<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div onclick="alert(1)">x</div></foreignObject><image href="https://evil.test/icon.png"></image><circle onclick="alert(1)" cx="5" cy="5" r="4"></circle></svg>',
      ),
    )

    const svg = root.querySelector('svg')
    expect(svg?.hasAttribute('onload')).toBe(false)
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('foreignObject')).toBeNull()
    expect(root.querySelector('image')).toBeNull()
    expect(root.querySelector('circle')?.hasAttribute('onclick')).toBe(false)
  })

  test('routes svg anchors through the normal safe navigation policy', () => {
    const root = parseFragment(
      sanitizeRichHtml(
        '<svg><a xlink:href="https://example.com/docs"><text>docs</text></a><a href="javascript:alert(1)"><text>bad</text></a></svg>',
      ),
    )

    const anchors = root.querySelectorAll('a')
    expect(anchors).toHaveLength(2)
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.com/docs')
    expect(anchors[0]?.getAttribute('target')).toBe('_blank')
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchors[1]?.hasAttribute('href')).toBe(false)
  })

  test('proxies third-party raster images through the same-origin remote image endpoint', () => {
    const root = parseFragment(
      sanitizeHtmlIsland('<div><img src="https://media.tenor.com/demo/tenor.gif" alt="demo"></div>'),
    )

    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/images/remote?url=https%3A%2F%2Fmedia.tenor.com%2Fdemo%2Ftenor.gif',
    )
  })

  test('keeps same-origin image URLs direct', () => {
    const root = parseFragment(
      sanitizeHtmlIsland('<div><img src="/api/v1/images/local-id" alt="local"></div>'),
    )

    expect(root.querySelector('img')?.getAttribute('src')).toBe('/api/v1/images/local-id')
  })

  test('keeps island style blocks while sanitizing inline svg content', () => {
    const root = parseFragment(
      sanitizeHtmlIsland(
        [
          '<style>.card { color: red; }</style>',
          '<div class="card">',
          '  <svg viewBox="0 0 10 10">',
          '    <defs><symbol id="icon"><path d="M0 0L10 10"/></symbol></defs>',
          '    <use href="#icon"></use>',
          '    <image href="https://evil.test/icon.png"></image>',
          '  </svg>',
          '</div>',
        ].join(''),
      ),
    )

    expect(root.querySelector('style')?.textContent).toContain('.card { color: red; }')
    expect(root.querySelector('use')?.getAttribute('href')).toBe('#icon')
    expect(root.querySelector('image')).toBeNull()
  })
})
