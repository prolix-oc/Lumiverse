import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { UI_LANGUAGES } from './languages'

const I18N = import.meta.dir
const SRC = `${I18N}/..`

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value as Record<string, unknown>, path))
    } else {
      expect(typeof value, path).toBe('string')
      out[path] = value as string
    }
  }
  return out
}

const load = (language: string, file: string) =>
  flatten(JSON.parse(readFileSync(`${I18N}/locales/${language}/${file}`, 'utf8')))
const tokens = (value: string) =>
  (value.match(/\{\{[^}]*\}\}|<\/?[A-Za-z0-9][^>]*>/g) ?? []).sort()

// i18n modules use Vite-only import.meta.glob; inspect their registration contract
// and load JSON directly rather than importing them in Bun.
describe('ko locale', () => {
  const files = readdirSync(`${I18N}/locales/en`).filter(file => file.endsWith('.json')).sort()

  test('ships every en namespace', () => {
    expect(readdirSync(`${I18N}/locales/ko`).filter(file => file.endsWith('.json')).sort()).toEqual(files)
  })

  test.each(files)('%s: covers every en key and preserves interpolation tokens and tags', file => {
    const en = load('en', file)
    const ko = load('ko', file)
    expect(Object.keys(ko).sort(), `${file}: full Korean key coverage`).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(ko)) {
      expect(en[key], `extra key ${file}:${key}`).toBeDefined()
      expect(value.trim(), `empty value ${file}:${key}`).not.toBe('')
      expect(tokens(value), `${file}:${key}`).toEqual(tokens(en[key]))
    }
  })

  test('registers Korean with English fallback in the Vite-only modules and switcher', () => {
    const index = readFileSync(`${I18N}/index.ts`, 'utf8')
    const resources = readFileSync(`${I18N}/resources.ts`, 'utf8')
    const switcher = readFileSync(`${SRC}/components/shared/LanguageSwitcher.tsx`, 'utf8')
    expect(UI_LANGUAGES).toContain('ko')
    expect(index).toContain("ko: ['en'],")
    expect(resources).toContain("ko: import.meta.glob('./locales/ko/*.json')")
    expect(switcher).toContain('UI_LANGUAGES.map')
    expect(load('en', 'common.json')['language.ko']).toBe('한국어')
  })
})
