import { describe, expect, test } from 'bun:test'
import en from '@/i18n/locales/en/panels.json'
import zh from '@/i18n/locales/zh/panels.json'
import zhTw from '@/i18n/locales/zh-TW/panels.json'
import ja from '@/i18n/locales/ja/panels.json'
import fr from '@/i18n/locales/fr/panels.json'
import it from '@/i18n/locales/it/panels.json'

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
}

describe('Agentic Runtime editor locale coverage', () => {
  test('keeps the complete editor key set in all six locales', () => {
    const expected = leafKeys(en.loomBuilder.agenticRuntime).sort()
    for (const locale of [zh, zhTw, ja, fr, it]) {
      expect(leafKeys(locale.loomBuilder.agenticRuntime).sort()).toEqual(expected)
    }
  })

  test('localizes primary labels rather than relying on English fallback text', () => {
    for (const locale of [zh, zhTw, ja, fr, it]) {
      expect(locale.loomBuilder.agenticRuntime.title).not.toBe(en.loomBuilder.agenticRuntime.title)
      expect(locale.loomBuilder.agenticRuntime.description).not.toBe(en.loomBuilder.agenticRuntime.description)
      expect(locale.loomBuilder.editorTabs.agenticRuntime).not.toBe(en.loomBuilder.editorTabs.agenticRuntime)
    }
  })
})
