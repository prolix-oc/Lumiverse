import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { worldBooksApi } from '@/api/world-books'
import WorldBookEntryEditor, { type EntryEditorConflictState } from '@/components/shared/WorldBookEntryEditor'
import type { WorldBookEntry } from '@/types/api'
import { classifyWorldBookEntryMutationError } from '@/lib/worldBookEntryConflict'
import {
  registerHostSurfaceRenderer,
  type HostSurfaceRenderContext,
} from './host-surface-registry'

const surfaceStyle: CSSProperties = {
  boxSizing: 'border-box',
  color: 'var(--lumiverse-text, inherit)',
  font: 'inherit',
  minHeight: 0,
  minWidth: 0,
}

const listStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

const buttonStyle: CSSProperties = {
  background: 'var(--lumiverse-surface-raised, transparent)',
  border: '1px solid var(--lumiverse-border-subtle, currentColor)',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  display: 'grid',
  gap: 2,
  padding: '8px 10px',
  textAlign: 'start',
  width: '100%',
}

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key]
  return typeof value === 'string' ? value : ''
}

function entryLabel(entry: WorldBookEntry): string {
  const comment = entry.comment?.trim()
  if (comment) return comment
  const key = entry.key.find(value => value.trim().length > 0)
  return key || 'Untitled entry'
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'World-book entries could not be loaded.'
}

export function WorldBookEntryTableSurface({
  props,
  context,
}: {
  props: Record<string, unknown>
  context: HostSurfaceRenderContext
}): ReactElement {
  const bookId = stringProp(props, 'bookId')
  const selectedEntryId = stringProp(props, 'selectedEntryId')
  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void worldBooksApi.listAllEntries(bookId).then(next => {
      if (controller.signal.aborted) return
      setEntries(next)
      setLoading(false)
    }, reason => {
      if (controller.signal.aborted) return
      setEntries([])
      setError(errorMessage(reason))
      setLoading(false)
    })
    return () => controller.abort()
  }, [bookId, retry])

  return (
    <section data-surface-id="world_book_entry_table" aria-label="World-book entries" aria-busy={loading} style={surfaceStyle}>
      {loading && <div role="status" aria-live="polite">Loading entries...</div>}
      {!loading && error && (
        <div role="alert">
          <span>{error}</span>
          <button type="button" style={buttonStyle} onClick={() => setRetry(value => value + 1)}>Retry</button>
        </div>
      )}
      {!loading && !error && entries.length === 0 && <div data-state="empty">This world book has no entries.</div>}
      {!loading && !error && entries.length > 0 && (
        <ul style={listStyle}>
          {entries.map(entry => (
            <li key={entry.id}>
              <button
                type="button"
                style={buttonStyle}
                aria-pressed={entry.id === selectedEntryId}
                onClick={() => context.emit('select', { entryId: entry.id })}
              >
                <strong>{entryLabel(entry)}</strong>
                <span>{entry.content.slice(0, 160) || 'Empty entry'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function WorldBookEntryEditorSurface({ props }: { props: Record<string, unknown> }): ReactElement {
  const bookId = stringProp(props, 'bookId')
  const entryId = stringProp(props, 'entryId')
  const density = props.density === 'compact' ? 'compact' : 'default'
  const [entry, setEntry] = useState<WorldBookEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<EntryEditorConflictState | null>(null)
  const pendingUpdates = useRef<Record<string, unknown> | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const current = await worldBooksApi.getEntry(bookId, entryId)
      if (generation.current !== requestGeneration) return
      setEntry(current)
      setConflict(null)
    } catch (reason) {
      if (generation.current !== requestGeneration) return
      setEntry(null)
      setError(errorMessage(reason))
    } finally {
      if (generation.current === requestGeneration) setLoading(false)
    }
  }, [bookId, entryId])

  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])

  const commit = useCallback((updates: Record<string, unknown>, expectedRevision: number) => {
    pendingUpdates.current = { ...updates }
    const requestGeneration = ++generation.current
    void worldBooksApi.updateEntry(bookId, entryId, {
      ...updates,
      expected_revision: expectedRevision,
    }).then(saved => {
      if (generation.current !== requestGeneration) return
      setEntry(saved)
      pendingUpdates.current = null
      setConflict(null)
      setError(null)
    }, reason => {
      if (generation.current !== requestGeneration) return
      const issue = classifyWorldBookEntryMutationError(reason)
      if (issue?.kind === 'conflict') {
        const currentEntry = issue.payload.conflicts.find(item => item.id === entryId)?.current ?? null
        setConflict({ kind: 'conflict', current: currentEntry })
        return
      }
      if (issue?.kind === 'malformed-precondition') {
        setConflict({ kind: 'malformed-precondition', message: issue.payload.message })
        return
      }
      setError(errorMessage(reason))
    })
  }, [bookId, entryId])

  const save = useCallback((updates: Record<string, unknown>) => {
    if (!entry) return
    commit(updates, entry.revision)
  }, [commit, entry])

  const retryConflict = useCallback(() => {
    const updates = pendingUpdates.current
    if (!updates) return
    const requestGeneration = ++generation.current
    void worldBooksApi.getEntry(bookId, entryId).then(current => {
      if (generation.current !== requestGeneration) return
      setEntry(current)
      setConflict(null)
      commit(updates, current.revision)
    }, reason => {
      if (generation.current === requestGeneration) setError(errorMessage(reason))
    })
  }, [bookId, commit, entryId])

  const useServer = useCallback(() => {
    pendingUpdates.current = null
    void load()
  }, [load])

  return (
    <section data-surface-id="world_book_entry_editor" aria-label="World-book entry editor" aria-busy={loading} style={surfaceStyle}>
      {loading && <div role="status" aria-live="polite">Loading entry...</div>}
      {!loading && error && <div role="alert">{error}</div>}
      {!loading && entry && (
        <WorldBookEntryEditor
          key={entry.id}
          entry={entry}
          density={density}
          onUpdate={(_id, updates) => save(updates)}
          onImmediateUpdate={(_id, updates) => save(updates)}
          conflict={conflict}
          onRetryConflict={retryConflict}
          onUseServerConflict={useServer}
        />
      )}
    </section>
  )
}

const unregisterRenderers = [
  registerHostSurfaceRenderer('world_book_entry_table', (props, context) => (
    <WorldBookEntryTableSurface props={props} context={context} />
  )),
  registerHostSurfaceRenderer('world_book_entry_editor', props => (
    <WorldBookEntryEditorSurface props={props} />
  )),
]
if (import.meta.hot) import.meta.hot.dispose(() => unregisterRenderers.forEach(unregister => unregister()))
