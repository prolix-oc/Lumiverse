import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { changeUiLanguage } from '@/i18n'
import styles from './LanguageSwitcher.module.css'

const LANGUAGES = [
  { code: 'en', labelKey: 'language.en' },
  { code: 'zh', labelKey: 'language.zh' },
  { code: 'zh-TW', labelKey: 'language.zh-TW' },
  { code: 'ja', labelKey: 'language.ja' },
  { code: 'fr', labelKey: 'language.fr' },
  { code: 'it', labelKey: 'language.it' },
] as const

interface LanguageSwitcherProps {
  className?: string
}

type UiLanguage = (typeof LANGUAGES)[number]['code']

function resolveUiLanguage(language?: string, resolvedLanguage?: string): UiLanguage {
  const normalized = (language || resolvedLanguage || 'en').replaceAll('_', '-').toLowerCase()
  if (normalized === 'zh-tw' || normalized.startsWith('zh-tw-')) return 'zh-TW'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja'
  if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr'
  if (normalized === 'it' || normalized.startsWith('it-')) return 'it'
  return 'en'
}

export default function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation('common')
  const current = resolveUiLanguage(i18n.language, i18n.resolvedLanguage)

  const setLanguage = (code: string) => {
    void changeUiLanguage(code)
  }

  return (
    <div className={clsx(styles.root, className)}>
      <label className={styles.label} htmlFor="lumiverse-ui-language">
        {t('language.label')}
      </label>
      <p className={styles.helper}>{t('language.helper')}</p>
      <select
        id="lumiverse-ui-language"
        className={styles.select}
        value={current}
        onChange={(e) => setLanguage(e.target.value)}
        aria-label={t('language.label')}
      >
        {LANGUAGES.map(({ code, labelKey }) => (
          <option key={code} value={code}>
            {t(labelKey)}
          </option>
        ))}
      </select>
    </div>
  )
}
