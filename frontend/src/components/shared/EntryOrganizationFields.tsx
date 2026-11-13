import { useEffect, useId, useRef, useState } from 'react'
import { worldBooksApi } from '@/api/world-books'
import styles from './EntryOrganization.module.css'

export default function EntryOrganizationFields({ bookId, folder, tags, onChange }: {
  bookId: string
  folder: string; tags: string[]
  onChange: (updates: { folder?: string; tags?: string[] }) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(folder)
  const [tag, setTag] = useState('')
  const focused = useRef(false)
  const [folders, setFolders] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  useEffect(() => { if (!focused.current) setDraft(folder) }, [folder])
  useEffect(() => {
    let current = true
    void worldBooksApi.getEntryOrganization(bookId).then(summary => { if (current) { setFolders(summary.folders.map(item => item.name)); setSuggestions(summary.tags.map(item => item.name)) } }).catch(() => {})
    return () => { current = false }
  }, [bookId])
  const add = () => {
    const value = tag.trim()
    if (value) onChange({ tags: [...new Set([...tags, value])] })
    setTag('')
  }
  return <fieldset className={styles.fields}>
    <legend>Organization</legend>
    <label>Folder
      <input aria-label="Entry folder" list={`${id}-folders`} value={draft} placeholder="Unfiled"
        onFocus={() => { focused.current = true }} onChange={event => setDraft(event.target.value)}
        onBlur={() => { focused.current = false; const value = draft.trim(); setDraft(value); if (value !== folder) onChange({ folder: value }) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
    </label>
    <datalist id={`${id}-folders`}>{folders.map(name => <option key={name} value={name} />)}</datalist>
    <label>Add tag
      <input aria-label="Add entry tag" list={`${id}-tags`} value={tag} onChange={event => setTag(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
    </label>
    <datalist id={`${id}-tags`}>{suggestions.map(value => <option key={value} value={value} />)}</datalist>
    <button type="button" disabled={!tag.trim()} onClick={add}>Add tag</button>
    {tags.length > 0 && <div className={styles.chips} aria-label="Entry tags">{tags.map(value =>
      <button type="button" key={value} aria-label={`Remove tag ${value}`} onClick={() => onChange({ tags: tags.filter(t => t !== value) })}>{value} ×</button>,
    )}</div>}
  </fieldset>
}
