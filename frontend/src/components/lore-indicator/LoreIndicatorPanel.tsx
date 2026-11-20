import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  CaseSensitive,
  Clock,
  ExternalLink,
  EyeOff,
  GripVertical,
  KeyRound,
  PanelRightOpen,
  Pin,
  Search,
  Shapes,
  Sparkles,
} from 'lucide-react'
import { useStore } from '@/store'
import { normalizeLoreIndicatorEntryTypeAppearance } from '@/lib/uiProductivityDefaults'
import { launchLorebookEditor } from '@/lib/lorebookLauncher'
import type { ActivatedWorldInfoEntry } from '@/types/api'
import type { LoreIndicatorGroupBy } from '@/types/store'
import {
  buildLoreScanText,
  formatCompactNumber,
  getActivationContext,
  getLastScannedSentence,
  searchLoreEntries,
  type LoreActivationContext,
} from './utils'
import styles from './LoreIndicator.module.css'

interface LoreIndicatorPanelProps {
  mode?: 'compact' | 'expanded' | 'palette'
  onNavigate?: () => void
  onMovePointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
  onHide?: () => void
  /** V4 only: how the expanded grid groups entries. */
  groupBy?: LoreIndicatorGroupBy
  /** V4 only: entries listed per group before the "+N more" affordance. */
  previewCount?: number
  onOpenFullView?: (entry: ActivatedWorldInfoEntry | null) => void
  /**
   * Open the entry in the editor on a single click instead of selecting it.
   * The V4 popover has no detail pane, so clicking through is the only useful
   * action there; the drawer's Activated Lore tab keeps select-then-double-click.
   */
  activateOnClick?: boolean
}

const TYPE_ICONS = {
  constant: Pin,
  sticky: Clock,
  keyword: KeyRound,
  vector: Search,
}

const CONFIGURED_ICONS = {
  pin: Pin,
  key: KeyRound,
  search: Search,
  book: BookOpen,
  sparkles: Sparkles,
}

const ACTIVATION_TYPES = ['constant', 'sticky', 'keyword', 'vector'] as const
type ActivationType = (typeof ACTIVATION_TYPES)[number]
const TYPE_LABELS: Record<ActivationType, string> = {
  constant: 'Constant',
  sticky: 'Sticky',
  keyword: 'Keyword',
  vector: 'Vector',
}

function normalizeActivationType(value: unknown): ActivationType {
  return ACTIVATION_TYPES.includes(value as ActivationType) ? value as ActivationType : 'keyword'
}

const COMPACT_TYPE_DISPLAY_KEY = 'lumiverse:lore-indicator:v2-type-display'

function readCompactTypeDisplay(): 'letters' | 'icons' {
  if (typeof window === 'undefined') return 'letters'
  return window.localStorage.getItem(COMPACT_TYPE_DISPLAY_KEY) === 'icons' ? 'icons' : 'letters'
}

function getCompactBookLabel(bookName: string) {
  const withoutTimestamp = bookName.replace(/\s+-\s+\d{4}-\d{2}-\d{2}.*$/, '').trim()
  if (/^ltm\b/i.test(withoutTimestamp)) return 'LTM'
  const parts = withoutTimestamp.split(/\s+-\s+/).filter(Boolean)
  const label = parts.length > 1 ? parts.at(-1)! : withoutTimestamp
  return label.replace(/^the\s+/i, '').trim() || bookName
}

function getCompactBookMarker(bookName: string) {
  const words = getCompactBookLabel(bookName).split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'B'
}

export function openNativeLoreEntry(entry: ActivatedWorldInfoEntry): void {
  const state = useStore.getState()
  state.setPendingWorldBookEditId(entry.bookId)
  state.setPendingWorldBookEditEntryId(entry.id)
  state.openDrawer('lorebook')
}

export function openLoreEntry(entry: ActivatedWorldInfoEntry): void {
  if (launchLorebookEditor({ bookId: entry.bookId, entryId: entry.id })) return
  openNativeLoreEntry(entry)
}

/**
 * Text the activation scan ran against. The payload carries no per-entry
 * excerpt, so the trigger sentence is derived from the generation query plus the
 * most recent messages.
 */
export function useLoreScanText(): string {
  const queryPreview = useStore((state) => state.worldInfoStats?.queryPreview)
  const messages = useStore((state) => state.messages)
  return useMemo(() => buildLoreScanText(queryPreview, messages), [messages, queryPreview])
}

export default function LoreIndicatorPanel({
  mode = 'expanded',
  onNavigate,
  onMovePointerDown,
  onHide,
  groupBy = 'lorebook',
  previewCount = 4,
  onOpenFullView,
  activateOnClick = false,
}: LoreIndicatorPanelProps) {
  const entries = useStore((state) => state.activatedWorldInfo)
  const stats = useStore((state) => state.worldInfoStats)
  const tokenBudget = useStore((state) => state.worldInfoSettings.maxTokenBudget)
  const storedSettings = useStore((state) => state.loreIndicatorSettings)
  const settings = useMemo(() => ({
    ...storedSettings,
    entryTypeAppearance: normalizeLoreIndicatorEntryTypeAppearance(storedSettings.entryTypeAppearance),
  }), [storedSettings])
  const editorSettings = useStore((state) => state.lorebookEditorSettings)
  const scanText = useLoreScanText()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | ActivationType>('all')
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.id ?? null)
  const [compactTypeDisplay, setCompactTypeDisplay] = useState(readCompactTypeDisplay)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const compact = mode === 'compact'

  const contexts = useMemo(
    () => new Map<string, LoreActivationContext>(
      entries.map((entry) => [entry.id, getActivationContext(entry, scanText)]),
    ),
    [entries, scanText],
  )

  const filteredEntries = useMemo(() => {
    const searched = searchLoreEntries(entries, query)
    return typeFilter === 'all'
      ? searched
      : searched.filter((entry) => entry.activationType === typeFilter)
  }, [entries, query, typeFilter])
  const visibleEntries = filteredEntries
  const selected = visibleEntries.find((entry) => entry.id === selectedId) ?? visibleEntries[0] ?? null
  const counts = useMemo(() => ({
    constant: entries.filter((entry) => entry.activationType === 'constant').length,
    sticky: entries.filter((entry) => entry.activationType === 'sticky').length,
    keyword: entries.filter((entry) => entry.activationType === 'keyword').length,
    vector: entries.filter((entry) => entry.activationType === 'vector').length,
  }), [entries])

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  // Arrow-key navigation and Enter/⌘Enter shortcuts for the V5 palette.
  //
  // Scoped to the palette subtree: the palette layer does not block pointer
  // events, so a document-wide listener would swallow Enter in the chat composer
  // while the palette happened to be open.
  useEffect(() => {
    if (mode !== 'palette') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (visibleEntries.length === 0) return
      const target = event.target as Node | null
      if (!target || !panelRef.current?.contains(target)) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const index = visibleEntries.findIndex((entry) => entry.id === selected?.id)
        const next = event.key === 'ArrowDown'
          ? Math.min(visibleEntries.length - 1, index + 1)
          : Math.max(0, index - 1)
        setSelectedId(visibleEntries[next]?.id ?? null)
        return
      }
      if (event.key === 'Enter' && selected) {
        event.preventDefault()
        if ((event.metaKey || event.ctrlKey) && editorSettings.loreIndicatorActionEnabled) {
          if (!launchLorebookEditor({
            bookId: selected.bookId,
            entryId: selected.id,
            preferredTarget: 'half',
            source: 'half_editor',
          })) {
            openNativeLoreEntry(selected)
          }
        } else {
          openLoreEntry(selected)
        }
        onNavigate?.()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    editorSettings.loreIndicatorActionEnabled,
    mode,
    onNavigate,
    selected,
    visibleEntries,
  ])

  const groups = useMemo(() => {
    const grouped = new Map<string, ActivatedWorldInfoEntry[]>()
    for (const entry of visibleEntries) {
      const label = mode === 'expanded' && groupBy === 'type'
        ? TYPE_LABELS[normalizeActivationType(entry.activationType)]
        : mode === 'expanded' && groupBy === 'none'
          ? 'Activated entries'
          : entry.bookName || entry.bookId
      grouped.set(label, [...(grouped.get(label) ?? []), entry])
    }
    return [...grouped.entries()]
  }, [groupBy, mode, visibleEntries])

  const navigate = (entry: ActivatedWorldInfoEntry) => {
    openLoreEntry(entry)
    onNavigate?.()
  }

  const openHalfEditor = (entry: ActivatedWorldInfoEntry) => {
    if (!launchLorebookEditor({
      bookId: entry.bookId,
      entryId: entry.id,
      preferredTarget: 'half',
      source: 'half_editor',
    })) {
      openNativeLoreEntry(entry)
    }
    onNavigate?.()
  }

  const panelClassName = compact
    ? styles.compactPanel
    : mode === 'palette'
      ? `${styles.panel} ${styles.palettePanel}`
      : `${styles.panel} ${styles.expandedPanel}`

  const typeFilterRow = (
    <div className={styles.typeChips} role="group" aria-label="Filter by activation type">
      <button
        type="button"
        className={styles.typeChip}
        data-active={typeFilter === 'all' || undefined}
        aria-pressed={typeFilter === 'all'}
        onClick={() => setTypeFilter('all')}
      >
        All<b>{entries.length}</b>
      </button>
      {ACTIVATION_TYPES.map((type) => {
        const appearance = settings.entryTypeAppearance[type]
        const Icon = CONFIGURED_ICONS[appearance.icon as keyof typeof CONFIGURED_ICONS] ?? TYPE_ICONS[type]
        return (
          <button
            key={type}
            type="button"
            className={styles.typeChip}
            data-activation={type}
            data-active={typeFilter === type || undefined}
            aria-pressed={typeFilter === type}
            onClick={() => setTypeFilter(type)}
          >
            <Icon size={12} style={{ color: appearance.color }} />
            {TYPE_LABELS[type]}<b>{counts[type]}</b>
          </button>
        )
      })}
    </div>
  )

  return (
    <div
      ref={panelRef}
      className={panelClassName}
      data-panel-mode={mode}
      style={{
        '--lore-icon-size': `${settings.iconSize}px`,
        '--lore-text-size': `${settings.textSize}px`,
      } as React.CSSProperties}
    >
      {compact ? (
        <div className={styles.compactHeader}>
          <strong>Lore {entries.length}</strong>
          <span className={styles.compactTypeCount} data-activation="constant">Constant {counts.constant}</span>
          <span className={styles.compactTypeCount} data-activation="sticky">Sticky {counts.sticky}</span>
          <span className={styles.compactTypeCount} data-activation="keyword">Keyword {counts.keyword}</span>
          <span className={styles.compactTypeCount} data-activation="vector">Vector {counts.vector}</span>
          <span className={styles.compactPasses}>{stats?.recursionPassesUsed ?? 0} passes</span>
          <button
            type="button"
            className={styles.compactDisplayToggle}
            onClick={() => {
              const next = compactTypeDisplay === 'letters' ? 'icons' : 'letters'
              setCompactTypeDisplay(next)
              window.localStorage.setItem(COMPACT_TYPE_DISPLAY_KEY, next)
            }}
            title={compactTypeDisplay === 'letters' ? 'Use type icons' : 'Use type letters'}
            aria-label={compactTypeDisplay === 'letters' ? 'Use type icons' : 'Use type letters'}
          >
            {compactTypeDisplay === 'letters' ? <Shapes size={14} /> : <CaseSensitive size={15} />}
          </button>
        </div>
      ) : (
        <div className={styles.panelHeader}>
          <span className={styles.panelHeaderIcon}><BookOpen size={16} /></span>
          <div className={styles.panelHeaderIdentity}>
            <strong>
              Activated Lore
              <b className={styles.panelHeaderBadge}>{entries.length}</b>
            </strong>
            <span>
              Last generation
              {' • '}
              {formatCompactNumber(stats?.estimatedTokens ?? 0)} tokens
              {' • '}
              {stats?.recursionPassesUsed ?? 0} {stats?.recursionPassesUsed === 1 ? 'pass' : 'passes'}
            </span>
          </div>
          {mode === 'expanded' && onOpenFullView && (
            <button type="button" className={styles.panelHeaderAction} onClick={() => onOpenFullView(selected)}>
              <ExternalLink size={13} /> Open full view
            </button>
          )}
        </div>
      )}

      {mode === 'palette' && (
        <div className={styles.paletteControls}>
          <label className={styles.searchBox}>
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search entries, books, triggers..."
              autoFocus
            />
          </label>
          {typeFilterRow}
        </div>
      )}

      {mode === 'expanded' && typeFilterRow}

      <div className={compact ? styles.compactList : mode === 'palette' ? styles.panelBody : styles.expandedBody}>
        {compact ? (
          <div className={styles.compactEntries}>
            {(settings.v2BookDisplay === 'grouped'
              ? groups.flatMap(([bookName, bookEntries]) => [
                  { kind: 'book' as const, bookName, id: `book:${bookName}` },
                  ...bookEntries.map((entry) => ({ kind: 'entry' as const, entry, id: entry.id })),
                ])
              : visibleEntries.map((entry) => ({ kind: 'entry' as const, entry, id: entry.id })))
              .map((item, index, items) => {
              if (item.kind === 'book') {
                return (
                  <div key={item.id} className={styles.compactBookHeading} title={item.bookName}>
                    <BookOpen size={11} />
                    <strong>{getCompactBookLabel(item.bookName)}</strong>
                  </div>
                )
              }

              const entry = item.entry
              const activationType = normalizeActivationType(entry.activationType)
              const appearance = settings.entryTypeAppearance[activationType]
              const TypeIcon = CONFIGURED_ICONS[appearance.icon as keyof typeof CONFIGURED_ICONS] ?? TYPE_ICONS[activationType]
              const triggerPhrase = contexts.get(entry.id)?.exactTriggerPhrase ?? null
              const entryName = entry.comment || 'Unnamed entry'
              const bookName = entry.bookName || entry.bookId
              const compactBookLabel = getCompactBookLabel(bookName)
              const previousItem = index > 0 ? items[index - 1] : null
              const previousEntry = previousItem?.kind === 'entry'
                ? previousItem.entry
                : null
              const showFirstOnlyBook = settings.v2BookDisplay === 'first-only'
                && (!previousEntry || (previousEntry.bookName || previousEntry.bookId) !== bookName)
              const activationMarker = entry.activationType === 'constant'
                ? 'C'
                : entry.activationType === 'sticky'
                  ? 'S'
                  : entry.activationType === 'keyword'
                    ? 'K'
                    : 'V'
              const activationDetail = entry.activationType === 'vector' && entry.score != null
                ? ` / score ${entry.score.toFixed(2)}`
                : entry.activationType === 'keyword' && triggerPhrase
                  ? ` / trigger "${triggerPhrase}"`
                  : ''
              return (
                <button
                  type="button"
                  key={entry.id}
                  className={styles.compactEntry}
                  data-activation={entry.activationType}
                  data-book-display={settings.v2BookDisplay}
                  onClick={() => navigate(entry)}
                  title={`${entryName} / ${bookName} / ${entry.activationType}${activationDetail}`}
                >
                  <span
                    className={styles.compactTypeMarker}
                    data-activation={entry.activationType}
                    data-display={compactTypeDisplay}
                  >
                    {compactTypeDisplay === 'icons'
                      ? <TypeIcon size={11} style={{ color: appearance.color }} />
                      : activationMarker}
                  </span>
                  <strong className={styles.compactEntryName}>{entryName}</strong>
                  {settings.v2BookDisplay === 'first-only' && (
                    <span
                      className={styles.compactBookChip}
                      data-empty={!showFirstOnlyBook || undefined}
                      title={showFirstOnlyBook ? bookName : undefined}
                    >
                      {showFirstOnlyBook ? compactBookLabel : ''}
                    </span>
                  )}
                  {settings.v2BookDisplay === 'markers' && (
                    <span className={styles.compactBookMarker} title={bookName}>{getCompactBookMarker(bookName)}</span>
                  )}
                  {settings.visibleMetadata.includes('tokens') && (
                    <strong className={styles.compactEntryTokens}>{formatCompactNumber(entry.estimatedTokens)}</strong>
                  )}
                </button>
              )
            })}
            {visibleEntries.length === 0 && <div className={styles.empty}>No activated lore entries.</div>}
          </div>
        ) : (
          <div className={styles.entryList}>
            {groups.map(([groupName, groupEntries]) => {
              const expanded = mode !== 'expanded' || expandedGroups.includes(groupName)
              const shown = expanded ? groupEntries : groupEntries.slice(0, Math.max(1, previewCount))
              const hidden = groupEntries.length - shown.length
              return (
                <section key={groupName} className={styles.bookGroup}>
                  <div className={styles.bookHeading}>
                    <BookOpen size={14} />
                    <span title={groupName}>{settings.visibleMetadata.includes('book') ? groupName : 'Activated entries'}</span>
                    <b>{groupEntries.length}</b>
                  </div>
                  {shown.map((entry) => {
                    const activationType = normalizeActivationType(entry.activationType)
                    const appearance = settings.entryTypeAppearance[activationType]
                    const TypeIcon = CONFIGURED_ICONS[appearance.icon as keyof typeof CONFIGURED_ICONS] ?? TYPE_ICONS[activationType]
                    const triggerPhrase = contexts.get(entry.id)?.exactTriggerPhrase ?? null
                    return (
                      <button
                        type="button"
                        key={entry.id}
                        className={entry.id === selected?.id ? styles.entryActive : styles.entry}
                        data-activation={entry.activationType}
                        onClick={() => activateOnClick ? navigate(entry) : setSelectedId(entry.id)}
                        onDoubleClick={() => navigate(entry)}
                      >
                        <TypeIcon size={settings.iconSize} style={{ color: appearance.color }} />
                        <span className={styles.entryIdentity}>
                          <strong>{entry.comment || 'Unnamed entry'}</strong>
                          <small>
                            {settings.visibleMetadata.includes('type') && (
                              <span className={styles.typeLabel} data-activation={entry.activationType}>{entry.activationType}</span>
                            )}
                            {settings.visibleMetadata.includes('trigger') && triggerPhrase ? ` / trigger: "${triggerPhrase}"` : ''}
                            {entry.score != null ? ` / ${entry.score.toFixed(2)}` : ''}
                          </small>
                        </span>
                        {settings.visibleMetadata.includes('tokens') && (
                          <span className={styles.entryTokens}>{formatCompactNumber(entry.estimatedTokens)}</span>
                        )}
                      </button>
                    )
                  })}
                  {hidden > 0 && (
                    <button
                      type="button"
                      className={styles.moreEntries}
                      onClick={() => setExpandedGroups((current) => [...current, groupName])}
                    >
                      + {hidden} more {hidden === 1 ? 'entry' : 'entries'}
                    </button>
                  )}
                </section>
              )
            })}
            {visibleEntries.length === 0 && <div className={styles.empty}>No activated lore matches this search.</div>}
          </div>
        )}

        {mode === 'palette' && selected && (
          <ActivationDetail
            entry={selected}
            context={contexts.get(selected.id) ?? getActivationContext(selected, scanText)}
            scanText={scanText}
            showHalfEditor={editorSettings.loreIndicatorActionEnabled}
            onHalfEditor={() => openHalfEditor(selected)}
            onOpen={() => navigate(selected)}
          />
        )}
      </div>

      {mode === 'palette' && settings.v5ShowShortcutHints !== false && (
        <div className={styles.paletteFooter}>
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          {editorSettings.loreIndicatorActionEnabled && <span><kbd>Ctrl</kbd><kbd>↵</kbd> Half editor</span>}
          <span><kbd>esc</kbd> Close</span>
        </div>
      )}

      {compact && (
        <div className={styles.compactFooter}>
          <div className={styles.compactTokenMetric}>
            <strong>
              {formatCompactNumber(stats?.estimatedTokens ?? 0)}
              {tokenBudget > 0 ? ` / ${formatCompactNumber(tokenBudget)}` : ''}
            </strong>
            <span className={styles.compactProgress} aria-hidden="true">
              <span
                style={{
                  width: `${tokenBudget > 0
                    ? Math.min(100, ((stats?.estimatedTokens ?? 0) / tokenBudget) * 100)
                    : 100}%`,
                }}
              />
            </span>
          </div>
          <div className={styles.compactActions}>
            {onMovePointerDown && (
              <button type="button" onPointerDown={onMovePointerDown} title="Drag to move" aria-label="Drag to move">
                <GripVertical size={14} />
              </button>
            )}
            {onHide && (
              <button type="button" onClick={onHide} title="Hide" aria-label="Hide">
                <EyeOff size={14} />
              </button>
            )}
            {selected && editorSettings.loreIndicatorActionEnabled && (
              <button type="button" onClick={() => openHalfEditor(selected)} title="Half-Screen Lorebook Editor" aria-label="Half-Screen Lorebook Editor">
                <PanelRightOpen size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ActivationDetail({
  entry,
  context,
  scanText,
  showHalfEditor,
  onHalfEditor,
  onOpen,
}: {
  entry: ActivatedWorldInfoEntry
  context: LoreActivationContext
  scanText: string
  showHalfEditor: boolean
  onHalfEditor: () => void
  onOpen: () => void
}) {
  const activation = entry.activationType === 'vector'
    ? `Vector match${entry.score != null ? ` / ${entry.score.toFixed(3)}` : ''}`
    : entry.activationType === 'constant'
      ? 'Constant entry'
      : entry.activationType === 'sticky'
        ? 'Sticky entry'
        : `Keyword match${context.exactTriggerPhrase ? ` / "${context.exactTriggerPhrase}"` : ''}`

  // Only the sentence the key appeared in — never the whole scanned message.
  const triggerSentence = entry.activationType === 'constant'
    ? null
    : entry.activationType === 'sticky'
      ? null
    : context.triggeringExcerpt ?? (entry.activationType === 'vector' ? getLastScannedSentence(scanText) : null)
  const triggerSentenceNote = entry.activationType === 'constant'
    ? 'This entry is always active, so no sentence triggered it.'
    : entry.activationType === 'sticky'
      ? 'This entry was kept active by sticky activation, so no sentence triggered it.'
    : entry.activationType === 'vector'
      ? 'Semantic activation has no literal trigger; showing the closing sentence of the scanned context.'
      : 'No scanned sentence contained a configured key.'

  return (
    <aside className={styles.detail}>
      <div className={styles.detailTitle}>
        <div>
          <strong>{entry.comment || 'Unnamed entry'}</strong>
          <span>{entry.bookName || entry.bookId}</span>
        </div>
        <div className={styles.detailActions}>
          {showHalfEditor && <button type="button" onClick={onHalfEditor}>Half editor</button>}
          <button type="button" onClick={onOpen}>Open entry</button>
        </div>
      </div>
      <dl>
        <dt>Activation</dt>
        <dd><span className={styles.typeLabel} data-activation={entry.activationType}>{activation}</span></dd>

        {context.exactTriggerPhrase && (
          <>
            <dt>Exact trigger phrase</dt>
            <dd className={styles.traceQuote}>&quot;{context.exactTriggerPhrase}&quot;</dd>
          </>
        )}

        {(context.matchedPrimaryKeys.length > 0 || context.matchedSecondaryKeys.length > 0) && (
          <>
            <dt>Matched keys</dt>
            <dd>
              {context.matchedPrimaryKeys.length > 0 && <div>Primary: {context.matchedPrimaryKeys.join(', ')}</div>}
              {context.matchedSecondaryKeys.length > 0 && <div>Secondary: {context.matchedSecondaryKeys.join(', ')}</div>}
            </dd>
          </>
        )}

        {entry.activationType === 'keyword' && context.matchedPrimaryKeys.length === 0 && context.configuredPrimaryKeys.length > 0 && (
          <>
            <dt>Configured primary keys</dt>
            <dd>{context.configuredPrimaryKeys.join(', ')} <span className={styles.unavailable}>(exact matched key unavailable)</span></dd>
          </>
        )}

        <dt>Matched because</dt>
        <dd>
          {context.matchedBecause
          ?? (entry.activationType === 'constant'
            ? 'This entry is configured as always active.'
            : entry.activationType === 'sticky'
              ? 'This entry was retained by sticky activation.'
            : entry.activationType === 'vector'
                ? `Semantic similarity activated this entry${entry.score != null ? ` with score ${entry.score.toFixed(3)}` : ''}.`
                : 'Keyword activation was reported; the payload did not include a match explanation.')}
        </dd>

        {context.matchedContentPreview && (
          <>
            <dt>Matched content preview</dt>
            <dd className={styles.tracePreview}>{context.matchedContentPreview}</dd>
          </>
        )}

        {context.whyActivated && (
          <>
            <dt>Why it activated</dt>
            <dd>{context.whyActivated}</dd>
          </>
        )}

        <dt>Triggering sentence</dt>
        <dd className={triggerSentence ? styles.tracePreview : styles.unavailable}>
          {triggerSentence ?? triggerSentenceNote}
        </dd>

        <dt>Source lorebook</dt>
        <dd>{entry.bookName || entry.bookId}</dd>

        <dt>Trace order</dt>
        <dd>#{entry.activationOrder + 1}{entry.firstTriggeredForBook ? ' / first triggered for book' : ''}</dd>

        <dt>Exact placement</dt>
        <dd>Position {entry.position} / Depth {entry.depth} / Priority {entry.priority} / {entry.preventRecursion ? 'Non-recursive' : 'Recursive'}</dd>

        <dt>Estimated size</dt>
        <dd>{formatCompactNumber(entry.estimatedTokens)} tokens</dd>
      </dl>
    </aside>
  )
}
