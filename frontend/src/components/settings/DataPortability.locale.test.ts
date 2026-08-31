import { describe, expect, test } from 'bun:test'
import en from '@/i18n/locales/en/settings.json'
import fr from '@/i18n/locales/fr/settings.json'
import it from '@/i18n/locales/it/settings.json'
import ja from '@/i18n/locales/ja/settings.json'
import zh from '@/i18n/locales/zh/settings.json'
import zhTW from '@/i18n/locales/zh-TW/settings.json'

const locales = { en, fr, it, ja, zh, 'zh-TW': zhTW } as const
const ticketMarkers = {
  en: 'ticket',
  fr: 'ticket',
  it: 'ticket',
  ja: 'チケット',
  zh: '票据',
  'zh-TW': '票據',
} as const

function flattenStrings(value: unknown, prefix = '', target = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') {
    target.set(prefix, value)
    return target
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return target
  for (const [key, child] of Object.entries(value)) {
    flattenStrings(child, prefix ? `${prefix}.${key}` : key, target)
  }
  return target
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]).sort()
}

describe('Data Portability settings locales', () => {
  test('keep the complete leaf and interpolation contract in all six locales', () => {
    const canonical = flattenStrings(en.dataPortability)
    const canonicalKeys = [...canonical.keys()].sort()

    for (const [locale, settings] of Object.entries(locales)) {
      const values = flattenStrings(settings.dataPortability)
      expect([...values.keys()].sort(), locale).toEqual(canonicalKeys)
      for (const key of canonicalKeys) {
        expect(interpolationNames(values.get(key) ?? ''), `${locale}:${key}`).toEqual(
          interpolationNames(canonical.get(key) ?? ''),
        )
      }
    }
  })

  test('describes the opt-in ticket flow without a partial-secret warning key', () => {
    for (const [locale, settings] of Object.entries(locales)) {
      const portability = settings.dataPortability as Record<string, unknown>
      expect(portability.exportSecretsWarn, locale).toBeUndefined()
      expect(portability.exportSecretsWarn_other, locale).toBeUndefined()
      expect(settings.dataPortability.exportDesc, locale).toContain(ticketMarkers[locale as keyof typeof ticketMarkers])
      expect(settings.dataPortability.importDesc, locale).toContain(ticketMarkers[locale as keyof typeof ticketMarkers])
      expect(settings.dataPortability.exportPrepareFailed.length, locale).toBeGreaterThan(0)
    }
  })
})
