import type { ThemeInspectionOptions, ThemeInspectionResult } from 'lumiverse-spindle-types'
export type { ThemeInspectionOptions, ThemeInspectionResult } from 'lumiverse-spindle-types'

const allowedProperties = new Set([
  'color', 'background-color', 'display', 'visibility', 'position',
  'font-size', 'font-family', 'font-weight', 'line-height',
  'padding', 'margin', 'gap', 'border-radius', 'border-color', 'border-width',
  'overflow', 'overflow-x', 'overflow-y', 'width', 'height', 'opacity', 'box-shadow',
  'align-items', 'justify-content', 'flex-direction',
])

export function inspectThemeElements(input: ThemeInspectionOptions): ThemeInspectionResult {
  if (
    !input ||
    typeof input.selector !== 'string' ||
    !input.selector.trim() ||
    input.selector.length > 1000
  ) {
    throw new Error('INVALID_THEME_SELECTOR')
  }

  const remainingSelector = input.selector
    .replace(/\[data-(?:component|part)="[a-zA-Z0-9_-]+"\]/g, '')
    .replace(/:(?:scope|root|first-child|last-child)\b/g, '')
    .replace(/:nth-(?:child|of-type)\(\d{1,4}\)/g, '')
  if (!/^[a-zA-Z0-9_.*# >+~,\-]*$/.test(remainingSelector)) {
    throw new Error('INVALID_THEME_SELECTOR: use classes, tags, component or part selectors')
  }

  const names = input.properties ?? [
    'color', 'background-color', 'display', 'position',
    'font-size', 'padding', 'border-radius', 'overflow',
  ]
  if (
    !Array.isArray(names) ||
    names.length > 40 ||
    names.some((name) => typeof name !== 'string' || !allowedProperties.has(name))
  ) {
    throw new Error('INVALID_THEME_STYLE_PROPERTY')
  }
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 30)
  ) {
    throw new Error('INVALID_THEME_INSPECTION_LIMIT')
  }

  const nodes = document.querySelectorAll(input.selector)
  return {
    count: nodes.length,
    matches: Array.from(nodes)
      .slice(0, input.limit ?? 10)
      .map((node) => {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return {
          tag: node.tagName.toLowerCase(),
          visible:
            !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          styles: Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
        }
      }),
  }
}
