import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { CharacterSearchScope } from '@/lib/characterSearch'
import { isCharacterContentSearchValid } from '@/lib/characterSearch'
import styles from './CharacterSearchScopeControl.module.css'

export default function CharacterSearchScopeControl({ value, onChange, query }: {
  value: CharacterSearchScope
  onChange: (value: CharacterSearchScope) => void
  query: string
}) {
  const { t } = useTranslation('panels')
  const hintId = useId()
  return (
    <div className={styles.control}>
      <label className={styles.label}>
        {t('characterSearch.searchIn')}
        <select
          value={value}
          onChange={event => onChange(event.target.value as CharacterSearchScope)}
          aria-describedby={value === 'all' ? hintId : undefined}
          className={styles.select}
        >
          <option value="metadata">{t('characterSearch.metadata')}</option>
          <option value="all">{t('characterSearch.allFields')}</option>
        </select>
      </label>
      {value === 'all' && (
        <span id={hintId} className={styles.hint} role="status">
          {t(isCharacterContentSearchValid(query) ? 'characterSearch.allFieldsHint' : 'characterSearch.minimumCharacters')}
        </span>
      )}
    </div>
  )
}
