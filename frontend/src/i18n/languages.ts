export const UI_LANGUAGES = ['en', 'zh', 'zh-TW', 'ja', 'fr', 'it', 'de', 'ko'] as const

export type UiLanguage = (typeof UI_LANGUAGES)[number]

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en'

/** Names remain recognizable even when the current interface is unfamiliar. */
export const UI_LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: 'English', zh: '简体中文', 'zh-TW': '繁體中文', ja: '日本語',
  fr: 'Français', it: 'Italiano', de: 'Deutsch', ko: '한국어',
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && UI_LANGUAGES.includes(value as UiLanguage)
}
