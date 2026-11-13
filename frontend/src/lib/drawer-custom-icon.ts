import type { DrawerCustomIconData, DrawerCustomIconElement, DrawerCustomIconTag } from '@/types/store'

export const DRAWER_CUSTOM_ICON_MAX_BYTES = 32 * 1024
export const DRAWER_CUSTOM_ICON_MAX_ELEMENTS = 64

const ALLOWED_TAGS = new Set<DrawerCustomIconTag>([
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
])

const CONTAINER_TAGS = new Set(['svg', 'g'])
const NUMBER_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i
const PATH_PATTERN = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/
const POINTS_PATTERN = /^[0-9eE+.,\s-]+$/

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength
  return value.length * 2
}

function normalizePaint(value: string | null | undefined, fallback?: 'currentColor' | 'none'): 'currentColor' | 'none' | undefined {
  if (value == null || !value.trim()) return fallback
  return value.trim().toLowerCase() === 'none' ? 'none' : 'currentColor'
}

function normalizeNumber(value: string | null | undefined, options: { min?: number; max?: number } = {}): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (!NUMBER_PATTERN.test(trimmed)) return undefined
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return undefined
  if (options.min != null && numeric < options.min) return undefined
  if (options.max != null && numeric > options.max) return undefined
  return String(numeric)
}

function normalizeViewBox(value: string | null | undefined): string | null {
  const parts = value?.trim().split(/[\s,]+/).filter(Boolean) ?? []
  if (parts.length !== 4) return null
  const numbers = parts.map(Number)
  if (numbers.some((part) => !Number.isFinite(part))) return null
  if (numbers[2] <= 0 || numbers[3] <= 0) return null
  if (numbers.some((part) => Math.abs(part) > 100000)) return null
  return numbers.join(' ')
}

function normalizeEnum<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined
  const normalized = value.trim() as T
  return allowed.includes(normalized) ? normalized : undefined
}

function readAttr(element: Element, name: string): string | null {
  return element.getAttribute(name)
}

function sanitizePrimitiveElement(element: Element): DrawerCustomIconElement | null {
  const tag = element.tagName.toLowerCase() as DrawerCustomIconTag
  if (!ALLOWED_TAGS.has(tag)) return null

  const attrs: Record<string, string> = {}
  const fill = normalizePaint(readAttr(element, 'fill'))
  const stroke = normalizePaint(readAttr(element, 'stroke'))
  if (fill) attrs.fill = fill
  if (stroke) attrs.stroke = stroke

  const strokeWidth = normalizeNumber(readAttr(element, 'stroke-width'), { min: 0, max: 16 })
  const opacity = normalizeNumber(readAttr(element, 'opacity'), { min: 0, max: 1 })
  const fillOpacity = normalizeNumber(readAttr(element, 'fill-opacity'), { min: 0, max: 1 })
  const strokeOpacity = normalizeNumber(readAttr(element, 'stroke-opacity'), { min: 0, max: 1 })
  if (strokeWidth) attrs.strokeWidth = strokeWidth
  if (opacity) attrs.opacity = opacity
  if (fillOpacity) attrs.fillOpacity = fillOpacity
  if (strokeOpacity) attrs.strokeOpacity = strokeOpacity

  const strokeLinecap = normalizeEnum(readAttr(element, 'stroke-linecap'), ['butt', 'round', 'square'] as const)
  const strokeLinejoin = normalizeEnum(readAttr(element, 'stroke-linejoin'), ['miter', 'round', 'bevel'] as const)
  const fillRule = normalizeEnum(readAttr(element, 'fill-rule'), ['nonzero', 'evenodd'] as const)
  const clipRule = normalizeEnum(readAttr(element, 'clip-rule'), ['nonzero', 'evenodd'] as const)
  if (strokeLinecap) attrs.strokeLinecap = strokeLinecap
  if (strokeLinejoin) attrs.strokeLinejoin = strokeLinejoin
  if (fillRule) attrs.fillRule = fillRule
  if (clipRule) attrs.clipRule = clipRule

  if (tag === 'path') {
    const d = readAttr(element, 'd')?.trim() ?? ''
    if (!d || d.length > 12000 || !PATH_PATTERN.test(d)) return null
    attrs.d = d
  }

  if (tag === 'polyline' || tag === 'polygon') {
    const points = readAttr(element, 'points')?.trim() ?? ''
    if (!points || points.length > 6000 || !POINTS_PATTERN.test(points)) return null
    attrs.points = points
  }

  const numericAttrsByTag: Partial<Record<DrawerCustomIconTag, readonly string[]>> = {
    circle: ['cx', 'cy', 'r'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
  }
  for (const attr of numericAttrsByTag[tag] ?? []) {
    const value = normalizeNumber(readAttr(element, attr))
    if (value != null) attrs[attr] = value
  }

  return { tag, attrs }
}

function sanitizeStrokeAttrs(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  const fill = normalizePaint(readAttr(element, 'fill'))
  const stroke = normalizePaint(readAttr(element, 'stroke'))
  const strokeWidth = normalizeNumber(readAttr(element, 'stroke-width'), { min: 0, max: 16 })
  const strokeLinecap = normalizeEnum(readAttr(element, 'stroke-linecap'), ['butt', 'round', 'square'] as const)
  const strokeLinejoin = normalizeEnum(readAttr(element, 'stroke-linejoin'), ['miter', 'round', 'bevel'] as const)
  if (fill) attrs.fill = fill
  if (stroke) attrs.stroke = stroke
  if (strokeWidth) attrs.strokeWidth = strokeWidth
  if (strokeLinecap) attrs.strokeLinecap = strokeLinecap
  if (strokeLinejoin) attrs.strokeLinejoin = strokeLinejoin
  return attrs
}

function sanitizeRootAttrs(element: Element): Record<string, string> {
  return {
    fill: 'currentColor',
    stroke: 'none',
    ...sanitizeStrokeAttrs(element),
  }
}

function collectElements(
  parent: Element,
  output: DrawerCustomIconElement[],
  inheritedAttrs: Record<string, string> = {},
): void {
  for (const child of Array.from(parent.children)) {
    if (output.length >= DRAWER_CUSTOM_ICON_MAX_ELEMENTS) return
    const tag = child.tagName.toLowerCase()
    if (CONTAINER_TAGS.has(tag)) {
      collectElements(child, output, { ...inheritedAttrs, ...sanitizeStrokeAttrs(child) })
      continue
    }
    if (!ALLOWED_TAGS.has(tag as DrawerCustomIconTag)) continue
    const sanitized = sanitizePrimitiveElement(child)
    if (sanitized) output.push({ ...sanitized, attrs: { ...inheritedAttrs, ...sanitized.attrs } })
  }
}

export function sanitizeDrawerCustomIconData(value: unknown): DrawerCustomIconData | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const viewBox = normalizeViewBox(typeof candidate.viewBox === 'string' ? candidate.viewBox : null)
  if (!viewBox || !Array.isArray(candidate.elements) || candidate.elements.length === 0) return null

  const attrs: Record<string, string> = {}
  if (candidate.attrs && typeof candidate.attrs === 'object') {
    const rawAttrs = candidate.attrs as Record<string, unknown>
    const fill = normalizePaint(typeof rawAttrs.fill === 'string' ? rawAttrs.fill : null, 'currentColor')
    const stroke = normalizePaint(typeof rawAttrs.stroke === 'string' ? rawAttrs.stroke : null, 'none')
    if (fill) attrs.fill = fill
    if (stroke) attrs.stroke = stroke
    const strokeWidth = normalizeNumber(typeof rawAttrs.strokeWidth === 'string' ? rawAttrs.strokeWidth : null, { min: 0, max: 16 })
    const strokeLinecap = normalizeEnum(typeof rawAttrs.strokeLinecap === 'string' ? rawAttrs.strokeLinecap : null, ['butt', 'round', 'square'] as const)
    const strokeLinejoin = normalizeEnum(typeof rawAttrs.strokeLinejoin === 'string' ? rawAttrs.strokeLinejoin : null, ['miter', 'round', 'bevel'] as const)
    if (strokeWidth) attrs.strokeWidth = strokeWidth
    if (strokeLinecap) attrs.strokeLinecap = strokeLinecap
    if (strokeLinejoin) attrs.strokeLinejoin = strokeLinejoin
  } else {
    attrs.fill = 'currentColor'
    attrs.stroke = 'none'
  }

  const elements: DrawerCustomIconElement[] = []
  for (const rawElement of candidate.elements.slice(0, DRAWER_CUSTOM_ICON_MAX_ELEMENTS)) {
    if (!rawElement || typeof rawElement !== 'object') continue
    const raw = rawElement as Record<string, unknown>
    if (typeof raw.tag !== 'string' || !ALLOWED_TAGS.has(raw.tag as DrawerCustomIconTag)) continue
    if (!raw.attrs || typeof raw.attrs !== 'object') continue

    const tag = raw.tag as DrawerCustomIconTag
    const attrsCandidate = raw.attrs as Record<string, unknown>
    const attrsElement: Record<string, string> = {}
    const copyNumber = (key: string, min?: number, max?: number) => {
      const normalized = normalizeNumber(typeof attrsCandidate[key] === 'string' ? attrsCandidate[key] as string : null, { min, max })
      if (normalized != null) attrsElement[key] = normalized
    }

    if (tag === 'path') {
      const d = typeof attrsCandidate.d === 'string' ? attrsCandidate.d.trim() : ''
      if (!d || d.length > 12000 || !PATH_PATTERN.test(d)) continue
      attrsElement.d = d
    }
    if (tag === 'polyline' || tag === 'polygon') {
      const points = typeof attrsCandidate.points === 'string' ? attrsCandidate.points.trim() : ''
      if (!points || points.length > 6000 || !POINTS_PATTERN.test(points)) continue
      attrsElement.points = points
    }

    for (const key of numericAttrsByTagForData(tag)) copyNumber(key)
    copyNumber('strokeWidth', 0, 16)
    copyNumber('opacity', 0, 1)
    copyNumber('fillOpacity', 0, 1)
    copyNumber('strokeOpacity', 0, 1)

    const fill = normalizePaint(typeof attrsCandidate.fill === 'string' ? attrsCandidate.fill : null)
    const stroke = normalizePaint(typeof attrsCandidate.stroke === 'string' ? attrsCandidate.stroke : null)
    const strokeLinecap = normalizeEnum(typeof attrsCandidate.strokeLinecap === 'string' ? attrsCandidate.strokeLinecap : null, ['butt', 'round', 'square'] as const)
    const strokeLinejoin = normalizeEnum(typeof attrsCandidate.strokeLinejoin === 'string' ? attrsCandidate.strokeLinejoin : null, ['miter', 'round', 'bevel'] as const)
    const fillRule = normalizeEnum(typeof attrsCandidate.fillRule === 'string' ? attrsCandidate.fillRule : null, ['nonzero', 'evenodd'] as const)
    const clipRule = normalizeEnum(typeof attrsCandidate.clipRule === 'string' ? attrsCandidate.clipRule : null, ['nonzero', 'evenodd'] as const)
    if (fill) attrsElement.fill = fill
    if (stroke) attrsElement.stroke = stroke
    if (strokeLinecap) attrsElement.strokeLinecap = strokeLinecap
    if (strokeLinejoin) attrsElement.strokeLinejoin = strokeLinejoin
    if (fillRule) attrsElement.fillRule = fillRule
    if (clipRule) attrsElement.clipRule = clipRule

    elements.push({ tag, attrs: attrsElement })
  }

  if (!elements.length) return null
  return { viewBox, attrs, elements }
}

function numericAttrsByTagForData(tag: DrawerCustomIconTag): readonly string[] {
  switch (tag) {
    case 'circle': return ['cx', 'cy', 'r']
    case 'rect': return ['x', 'y', 'width', 'height', 'rx', 'ry']
    case 'line': return ['x1', 'y1', 'x2', 'y2']
    case 'ellipse': return ['cx', 'cy', 'rx', 'ry']
    default: return []
  }
}

export type DrawerCustomIconParseResult =
  | { ok: true; icon: DrawerCustomIconData }
  | { ok: false; error: string }

export function parseDrawerCustomIcon(rawInput: string): DrawerCustomIconParseResult {
  const input = rawInput.trim()
  if (!input) return { ok: false, error: 'Paste SVG markup or path data first.' }
  if (byteLength(input) > DRAWER_CUSTOM_ICON_MAX_BYTES) {
    return { ok: false, error: 'SVG is larger than the 32 KB icon limit.' }
  }
  if (typeof DOMParser === 'undefined') {
    return { ok: false, error: 'SVG parsing is not available in this environment.' }
  }

  const raw = input.replace(/^<\?xml[^>]*>\s*/i, '')
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    return { ok: false, error: 'DOCTYPE and entity declarations are not supported in custom icons.' }
  }
  const looksLikeMarkup = raw.startsWith('<')
  const isFullSvg = /^<svg(?:\s|>)/i.test(raw)
  const source = looksLikeMarkup
    ? isFullSvg ? raw : `<svg viewBox="0 0 24 24">${raw}</svg>`
    : `<svg viewBox="0 0 24 24"><path d="${escapeXmlAttribute(raw)}" /></svg>`

  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (document.querySelector('parsererror')) return { ok: false, error: 'That SVG could not be parsed.' }
  const root = document.documentElement
  if (root.tagName.toLowerCase() !== 'svg') return { ok: false, error: 'Expected an SVG document.' }

  const viewBox = normalizeViewBox(root.getAttribute('viewBox')) ?? '0 0 24 24'
  const elements: DrawerCustomIconElement[] = []
  collectElements(root, elements)
  if (!elements.length) {
    return { ok: false, error: 'No supported SVG paths or shapes were found.' }
  }

  const icon = sanitizeDrawerCustomIconData({
    viewBox,
    attrs: sanitizeRootAttrs(root),
    elements,
  })
  if (!icon) return { ok: false, error: 'The SVG did not contain a usable icon.' }
  return { ok: true, icon }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
