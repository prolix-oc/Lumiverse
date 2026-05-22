export const MAX_OVERRIDE_SOURCE_LENGTH = 50_000
export const MAX_AST_NODES = 2_000
export const MAX_RENDER_NODES = 1_000
export const MAX_RENDER_DEPTH = 40
export const MAX_MAP_ITEMS = 100

export const ALLOWED_JSX_TAGS = new Set([
  'a',
  'article',
  'aside',
  'blockquote',
  'br',
  'button',
  'code',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'img',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'time',
  'ul',
])

export const ALLOWED_GLOBAL_IDENTIFIERS = new Set(['clsx', 'undefined'])

export const ALLOWED_ACTION_PATHS = new Set([
  'actions.copy',
  'actions.edit',
  'actions.delete',
  'actions.toggleHidden',
  'actions.fork',
  'actions.promptBreakdown',
  'actions.swipeLeft',
  'actions.swipeRight',
  'editing.save',
  'editing.cancel',
])

export const ALLOWED_EVENT_PROPS = new Set(['onClick'])

export const FORBIDDEN_PROPERTY_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'ownerDocument',
  'defaultView',
])

export const FORBIDDEN_IDENTIFIERS = new Set([
  'React',
  'window',
  'document',
  'globalThis',
  'self',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'sendBeacon',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookie',
  'eval',
  'Function',
  'importScripts',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'WebAssembly',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'location',
  'history',
  'console',
  'require',
  'import',
])

export function isAllowedJsxProp(tag: string, prop: string): boolean {
  if (prop === 'key') return true
  if (prop === 'ref') return false
  if (prop === 'dangerouslySetInnerHTML') return false
  if (prop.startsWith('aria-') || prop.startsWith('data-')) return true
  if (ALLOWED_EVENT_PROPS.has(prop)) return tag === 'button' || tag === 'a'

  return [
    'alt',
    'className',
    'disabled',
    'height',
    'href',
    'id',
    'role',
    'src',
    'style',
    'target',
    'title',
    'type',
    'width',
  ].includes(prop)
}

export function isUrlProp(prop: string): boolean {
  return prop === 'href' || prop === 'src'
}

export function sanitizeUrl(value: string): string {
  if (/^\s*(javascript:|data:text\/html|vbscript:)/i.test(value)) return 'about:blank'
  return value
}
