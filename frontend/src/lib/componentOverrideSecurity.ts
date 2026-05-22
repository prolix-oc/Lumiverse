import type { ThemePack } from './themePack'

const MAX_OVERRIDE_SOURCE_LENGTH = 50_000

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\b(?:window|globalThis|document|ownerDocument|defaultView)\b/, message: 'Global DOM access is not allowed in component overrides.' },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon)\b/, message: 'Network APIs are not allowed in component overrides.' },
  { pattern: /\b(?:localStorage|sessionStorage|indexedDB|caches|cookie)\b/, message: 'Storage and cookie access are not allowed in component overrides.' },
  { pattern: /\b(?:Function|eval|importScripts|Worker|SharedWorker|ServiceWorker|WebAssembly)\b/, message: 'Dynamic code execution APIs are not allowed in component overrides.' },
  { pattern: /\b(?:postMessage|setTimeout|setInterval|requestAnimationFrame|location|history)\b/, message: 'Navigation and global async APIs are not allowed in component overrides.' },
  { pattern: /\b__proto__\b/, message: 'Prototype escape hatches are not allowed in component overrides.' },
  { pattern: /\.\s*(?:constructor|prototype)\b/, message: 'Constructor and prototype access are not allowed in component overrides.' },
  { pattern: /\[\s*["'](?:constructor|prototype|__proto__)["']\s*\]/, message: 'Constructor and prototype access are not allowed in component overrides.' },
  { pattern: /\b(?:cloneElement|createPortal|findDOMNode)\b/, message: 'DOM manipulation helpers are not allowed in component overrides.' },
  { pattern: /javascript:/i, message: 'javascript: URLs are not allowed in component overrides.' },
  { pattern: /<(?:script|iframe|object|embed)\b/i, message: 'Dangerous HTML tags are not allowed in component overrides.' },
]

export function validateComponentOverrideSource(source: string): { valid: boolean; error?: string } {
  if (source.length > MAX_OVERRIDE_SOURCE_LENGTH) {
    return { valid: false, error: `Override source is too large (max ${MAX_OVERRIDE_SOURCE_LENGTH.toLocaleString()} characters).` }
  }

  for (const { pattern, message } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return { valid: false, error: message }
    }
  }

  return { valid: true }
}

export function disableImportedThemePackTsx(pack: ThemePack): { pack: ThemePack; disabledCount: number } {
  let disabledCount = 0
  const components = Object.fromEntries(
    Object.entries(pack.components).map(([name, override]) => {
      const hasTsx = !!override.tsx.trim()
      if (hasTsx && override.enabled) disabledCount += 1
      return [name, {
        ...override,
        enabled: hasTsx ? false : override.enabled,
      }]
    }),
  ) as ThemePack['components']

  return {
    pack: { ...pack, components },
    disabledCount,
  }
}
