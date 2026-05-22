import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Search, X } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router'
import clsx from 'clsx'
import { useStore } from '@/store'
import { buildCommands, GROUP_ORDER, type Command, type CommandScope } from '@/lib/commands'
import { extensionTabsToCommands, extensionCommandsToCommands, sanitizeHiddenDrawerTabIds } from '@/lib/drawer-tab-registry'
import styles from './CommandPalette.module.css'

// ── Match highlight ────────────────────────────────────────────────────────────

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.match}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CommandPalette() {
  const isOpen = useStore((s) => s.commandPaletteOpen)
  const close = useStore((s) => s.closeCommandPalette)
  const userRole = useStore((s) => s.user?.role)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const extensionCommands = useStore((s) => s.extensionCommands)
  const activeChatId = useStore((s) => s.activeChatId)
  const messageCount = useStore((s) => s.messages.length)
  const streaming = useStore((s) => s.isStreaming)
  const navigate = useNavigate()
  const location = useLocation()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const isComposing = useRef(false)
  const scrollOnChange = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset state each time the palette opens
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [isOpen])

  // Determine active scopes based on route and store state
  const activeScopes = useMemo<Set<CommandScope>>(() => {
    const scopes = new Set<CommandScope>(['global'])
    const path = location.pathname

    if (path.startsWith('/chat/')) {
      scopes.add('chat')
      if (!streaming && messageCount > 0) scopes.add('chat-idle')
    } else if (path === '/') {
      scopes.add('landing')
    } else if (path === '/characters' || /^\/characters\/[^/]+/.test(path)) {
      scopes.add('character')
    }

    return scopes
  }, [location.pathname, streaming, messageCount])

  const hiddenTabIds = useMemo(
    () => new Set(sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)),
    [drawerSettings.hiddenTabIds],
  )

  const { grouped, orderedFlat, flatIndexMap } = useMemo(() => {
    const allCommands = [...buildCommands(userRole), ...extensionTabsToCommands(drawerTabs), ...extensionCommandsToCommands(extensionCommands)]
    
    let filtered = allCommands.filter((cmd) => {
      if (cmd.id.startsWith('panel-') && hiddenTabIds.has(cmd.id.slice('panel-'.length))) return false
      if (cmd.id.startsWith('ext-tab-') && hiddenTabIds.has(cmd.id.slice('ext-tab-'.length))) return false

      const isVisible = activeScopes.has(cmd.scope || 'global')
      if (!isVisible) return false

      const path = location.pathname
      if (cmd.id === 'action-new-chat' && path === '/') return false
      if (cmd.id === 'action-character-browser' && path === '/characters') return false

      if (query.trim()) {
        const q = query.toLowerCase()
        return (
          cmd.label.toLowerCase().includes(q) ||
          cmd.description.toLowerCase().includes(q) ||
          cmd.keywords.some((k) => k.toLowerCase().includes(q))
        )
      }
      return true
    })

    const map = new Map<Command['group'], Command[]>()
    for (const cmd of filtered) {
      const arr = map.get(cmd.group) ?? []
      arr.push(cmd)
      map.set(cmd.group, arr)
    }

    for (const [, items] of map) {
      items.sort((a, b) => a.label.localeCompare(b.label))
    }

    const groups: { group: Command['group']; items: Command[] }[] = []
    const flat: Command[] = []
    const idxMap = new Map<string, number>()

    for (const g of GROUP_ORDER) {
      const items = map.get(g)
      if (items?.length) {
        groups.push({ group: g, items })
        for (const item of items) {
          idxMap.set(item.id, flat.length)
          flat.push(item)
        }
      }
    }

    return { grouped: groups, orderedFlat: flat, flatIndexMap: idxMap }
  }, [query, userRole, drawerTabs, drawerSettings.hiddenTabIds, extensionCommands, activeScopes, location.pathname, hiddenTabIds])

  // Clamp active index when filtered list shrinks
  useEffect(() => {
    setActiveIndex((i) => (orderedFlat.length === 0 ? 0 : Math.min(i, orderedFlat.length - 1)))
  }, [orderedFlat.length])

  // Scroll active item into view on keyboard navigation only
  useEffect(() => {
    if (!scrollOnChange.current) return
    scrollOnChange.current = false
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function execute(cmd: Command) {
    close()
    setTimeout(() => void cmd.run(navigate), 10)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposing.current) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        scrollOnChange.current = true
        setActiveIndex((i) => Math.min(i + 1, orderedFlat.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        scrollOnChange.current = true
        setActiveIndex((i) => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (orderedFlat[activeIndex]) execute(orderedFlat[activeIndex])
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'Tab':
        e.preventDefault()
        scrollOnChange.current = true
        if (e.shiftKey) {
          setActiveIndex((i) => Math.max(i - 1, 0))
        } else {
          setActiveIndex((i) => Math.min(i + 1, orderedFlat.length - 1))
        }
        break
    }
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value)
    setActiveIndex(0)
  }

  function clearQuery() {
    setQuery('')
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={close}
        >
          <motion.div
            className={styles.palette}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Input ── */}
            <div className={styles.inputRow}>
              <Search size={16} className={styles.searchIcon} strokeWidth={1.75} />
              <input
                ref={inputRef}
                autoFocus
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={orderedFlat.length > 0}
                aria-activedescendant={orderedFlat[activeIndex] ? `cmd-${orderedFlat[activeIndex].id}` : undefined}
                className={styles.input}
                placeholder="Search commands…"
                value={query}
                onChange={handleQueryChange}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => { isComposing.current = true }}
                onCompositionEnd={() => { isComposing.current = false }}
              />
              {query && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={clearQuery}
                  tabIndex={-1}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className={styles.divider} />

            {/* ── Results ── */}
            <div
              ref={listRef}
              className={styles.results}
              role="listbox"
              aria-label="Commands"
            >
              {orderedFlat.length === 0 ? (
                <div className={styles.empty}>
                  No results for &ldquo;{query}&rdquo;
                </div>
              ) : (
                grouped.map(({ group, items }) => {
                  return (
                    <div key={group} className={styles.group} role="group" aria-label={group}>
                      <div className={styles.groupLabel}>{group}</div>
                      {items.map((cmd) => {
                        const idx = flatIndexMap.get(cmd.id) ?? -1
                        const isActive = idx === activeIndex
                        const Icon = cmd.icon
                        return (
                          <button
                            key={cmd.id}
                            id={`cmd-${cmd.id}`}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            data-idx={idx}
                            className={clsx(styles.item, isActive && styles.itemActive)}
                            onMouseEnter={() => setActiveIndex(idx)}
                            onClick={() => execute(cmd)}
                            tabIndex={-1}
                          >
                            <span className={styles.itemIcon}>
                              <Icon size={15} strokeWidth={1.75} />
                            </span>
                            <span className={styles.itemBody}>
                              <span className={styles.itemLabel}>
                                {highlightMatch(cmd.label, query)}
                              </span>
                              <span className={styles.itemDesc}>
                                {highlightMatch(cmd.description, query)}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )
                })
              )}
            </div>

            {/* ── Footer ── */}
            <div className={styles.footer}>
              <span className={styles.footerHint}>
                <kbd className={styles.kbd}>↑</kbd>
                <kbd className={styles.kbd}>↓</kbd>
                navigate
              </span>
              <span className={styles.footerHint}>
                <kbd className={styles.kbd}>↵</kbd>
                select
              </span>
              <span className={styles.footerHint}>
                <kbd className={styles.kbd}>Esc</kbd>
                close
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
