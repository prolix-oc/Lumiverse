import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { changeUiLanguage } from '@/i18n'
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, isUiLanguage } from '@/i18n/languages'
import { useStore } from '@/store'
import sectionStyles from '@/components/settings/SettingsSection.module.css'
import styles from './LanguageSwitcher.module.css'

interface LanguageSwitcherProps {
  className?: string
}

export default function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation('common')
  const current = isUiLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_UI_LANGUAGE

  const setLanguage = (code: string) => {
    if (!isUiLanguage(code)) return
    const state = useStore.getState()
    if (state.isAuthenticated) {
      state.setSetting('uiLanguage', code)
    } else {
      void changeUiLanguage(code)
    }
  }

  return (
    <div className={clsx(styles.root, className)}>
      <h3 className={clsx(sectionStyles.title, styles.label)} id="setsec-display-language">
        {t('language.label')}
      </h3>
      <p className={styles.helper}>{t('language.helper')}</p>
      <select
        id="lumiverse-ui-language"
        className={styles.select}
        value={current}
        onChange={(e) => setLanguage(e.target.value)}
        aria-label={t('language.label')}
      >
        {UI_LANGUAGES.map(code => (
          <option key={code} value={code}>
            {t(`language.${code}`)}
          </option>
        ))}
      </select>
    </div>
  )
}
