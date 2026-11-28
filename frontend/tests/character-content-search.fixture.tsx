import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import panels from '../src/i18n/locales/en/panels.json'
import common from '../src/i18n/locales/en/common.json'
import CharacterToolbar from '../src/components/panels/character-browser/CharacterToolbar'
import type { CharacterSearchScope } from '../src/lib/characterSearch'
import type { CharacterFilterTab } from '../src/types/store'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import '../src/theme/reset.css'
import '../src/theme/global.css'

await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { panels, common } } })
for (const [key, value] of Object.entries(generateThemeVariables(DEFAULT_THEME, 'dark'))) {
  document.documentElement.style.setProperty(key, value)
}
const noop = () => {}
function Fixture() {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<CharacterSearchScope>('metadata')
  const [filter, setFilter] = useState<CharacterFilterTab>('characters')
  return <main style={{ padding: 12, maxWidth: 700 }}>
    <CharacterToolbar searchQuery={query} onSearchChange={setQuery}
      searchScope={scope} onSearchScopeChange={setScope} filterTab={filter} onFilterTabChange={setFilter}
      sortField="name" onSortFieldChange={noop} sortDirection="asc" onToggleSortDirection={noop}
      viewMode="grid" onViewModeChange={noop} batchMode={false} onBatchModeChange={noop}
      onImportFile={noop} onImportTagLibrary={noop} onImportUrl={noop} onCreateNew={noop}
      onCreateFolder={noop} importLoading={false} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
