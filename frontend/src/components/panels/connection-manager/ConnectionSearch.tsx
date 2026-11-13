import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import SearchField from '@/components/shared/SearchField'
import { ConnectionSearchContext } from '@/hooks/useConnectionSearch'

export function ConnectionSearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('')
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  return <ConnectionSearchContext.Provider value={query}>
    <SearchField value={query} onChange={setQuery} placeholder={t('connections.search')}
      clearLabel={tc('actions.clear')} />
    {children}
  </ConnectionSearchContext.Provider>
}
