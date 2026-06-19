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

function resolveUiLanguage(resolved?: string): string {
  if (!resolved) return 'en'
  if (resolved === 'zh-TW' || resolved.startsWith('zh-TW')) return 'zh-TW'
  if (resolved.startsWith('zh')) return 'zh'
  if (resolved.startsWith('ja')) return 'ja'
  if (resolved.startsWith('fr')) return 'fr'
  return 'en'
}

export default function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation('common')
  const current = resolveUiLanguage(i18n.resolvedLanguage)

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
