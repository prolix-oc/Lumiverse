import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { formatPromptItemizerOutcomeReason } from '@/lib/i18n/promptItemizerOutcome'
import enChat from '@/i18n/locales/en/chat.json'
import enModals from '@/i18n/locales/en/modals.json'
import frChat from '@/i18n/locales/fr/chat.json'
import frModals from '@/i18n/locales/fr/modals.json'
import itChat from '@/i18n/locales/it/chat.json'
import itModals from '@/i18n/locales/it/modals.json'
import jaChat from '@/i18n/locales/ja/chat.json'
import jaModals from '@/i18n/locales/ja/modals.json'
import zhChat from '@/i18n/locales/zh/chat.json'
import zhModals from '@/i18n/locales/zh/modals.json'
import zhTWChat from '@/i18n/locales/zh-TW/chat.json'
import zhTWModals from '@/i18n/locales/zh-TW/modals.json'

const locales = [
  { language: 'en', chat: enChat, modals: enModals },
  { language: 'fr', chat: frChat, modals: frModals },
  { language: 'it', chat: itChat, modals: itModals },
  { language: 'ja', chat: jaChat, modals: jaModals },
  { language: 'zh', chat: zhChat, modals: zhModals },
  { language: 'zh-TW', chat: zhTWChat, modals: zhTWModals },
] as const

describe('PromptItemizerModal outcome reason localization', () => {
  test('renders response_mode as localized string copy in all six locales', async () => {
    for (const { language, chat, modals } of locales) {
      const instance = createInstance()
      await instance.init({
        lng: language,
        fallbackLng: false,
        defaultNS: 'chat',
        resources: { [language]: { chat } },
      })

      const rendered = formatPromptItemizerOutcomeReason(
        chat.ownerInspection.values.omitted,
        'response_mode',
        instance.t.bind(instance),
      )

      expect(rendered, `${language} outcome detail`).toBeString()
      expect(rendered).toContain(chat.ownerInspection.values.response_mode)
      expect(rendered).not.toContain('returned an object instead of string')
      expect('outcomeReason' in modals.promptItemizer.ar007).toBeFalse()
    }
  })
})
