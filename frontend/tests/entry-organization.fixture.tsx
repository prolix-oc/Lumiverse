import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Controls, { EntryFolderList } from '../src/components/shared/EntryOrganizationControls'
import Fields from '../src/components/shared/EntryOrganizationFields'
import { ModalShell } from '../src/components/shared/ModalShell'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import { fixtureRows, worldBooksApi } from './entry-organization.fixture-api'
import type { WorldBook, WorldBookEntryOrganizationSummary } from '../src/types/api'
import '../src/theme/reset.css'
import '../src/theme/global.css'
const books = [{ id: 'b1', name: 'Fixture source' }, { id: 'b2', name: 'Fixture target' }] as WorldBook[]
function Fixture() {
  const [open, setOpen] = useState(true)
  const [root, setRoot] = useState(true)
  const [folder, setFolder] = useState<string>()
  const [tags, setTags] = useState<string[]>([])
  const [summary, setSummary] = useState<WorldBookEntryOrganizationSummary | null>(null)
  const [version, setVersion] = useState(0)
  const reload = async () => { setSummary(await worldBooksApi.getEntryOrganization('b1')); setVersion(value => value + 1) }
  useLayoutEffect(() => {
    const scale = Number(new URLSearchParams(location.search).get('scale') ?? 1)
    for (const [key, value] of Object.entries(generateThemeVariables({ ...DEFAULT_THEME, uiScale: scale }, 'dark'))) document.documentElement.style.setProperty(key, value)
    void reload()
  }, [])
  const rows = fixtureRows.filter(row => row.world_book_id === 'b1' && (folder === undefined || folder === row.folder) && tags.every(tag => row.tags.includes(tag)))
  return <><button onClick={() => setOpen(true)}>Reopen fixture modal</button>
    <ModalShell isOpen={open} onClose={() => setOpen(false)} maxWidth="min(700px, calc(96vw / var(--lumiverse-ui-scale, 1)))" scrollable>
      <div data-testid="organization-surface" style={{ minWidth: 0, padding: 12 }}>
        <h2>Lorebook organization fixture</h2>
        <Controls key={open ? 'open' : 'closed'} bookId="b1" books={books} summary={summary} folder={folder} root={root} tags={tags} entries={rows} selectedIds={rows.map(row => row.id)} onRoot={() => setRoot(true)} onTags={setTags} onReload={reload} />
        {root ? <EntryFolderList summary={summary} onOpen={value => { setFolder(value); setRoot(false); setTags([]) }} />
          : <div data-testid="entry-region" data-version={version}>{rows.map(row => <article key={row.id}><h3>{row.comment}</h3><Fields bookId="b1" folder={row.folder} tags={row.tags} onChange={updates => { Object.assign(row, updates); row.revision++; void reload() }} /></article>)}</div>}
        <button onClick={() => setOpen(false)}>Close fixture modal</button>
      </div>
    </ModalShell>
  </>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
