import type { SpindleHostLocale } from 'lumiverse-spindle-types'

export type { SpindleHostLocale }

let currentLocale: SpindleHostLocale = 'en'
const listeners = new Set<(locale: SpindleHostLocale) => void>()

/** Map browser and i18next locale variants onto the host's stable locale set. */
export function normalizeHostLocale(value: unknown): SpindleHostLocale {
  if (typeof value !== 'string') return 'en'
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (!normalized) return 'en'
  if (
    normalized === 'zh-tw'
    || normalized.startsWith('zh-tw-')
    || normalized === 'zh-hant'
    || normalized.startsWith('zh-hant-')
  ) return 'zh-TW'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja'
  if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr'
  if (normalized === 'it' || normalized.startsWith('it-')) return 'it'
  return 'en'
}

/** Update the host locale from the host application's languageChanged source. */
export function setHostLocale(value: unknown): void {
  const nextLocale = normalizeHostLocale(value)
  if (nextLocale === currentLocale) return
  currentLocale = nextLocale
  for (const listener of [...listeners]) {
    try {
      listener(currentLocale)
    } catch (error) {
      console.error('[Spindle] Host locale listener failed:', error)
    }
  }
}

/** Read the current host locale synchronously. */
export function getHostLocale(): SpindleHostLocale {
  return currentLocale
}

/** Subscribe to host locale changes and return an idempotent disposer. */
export function subscribeHostLocale(listener: (locale: SpindleHostLocale) => void): () => void {
  let active = true
  const subscription = (locale: SpindleHostLocale) => listener(locale)
  listeners.add(subscription)
  return () => {
    if (!active) return
    active = false
    listeners.delete(subscription)
  }
}
