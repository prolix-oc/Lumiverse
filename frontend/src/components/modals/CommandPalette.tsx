import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Puzzle, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import clsx from 'clsx'
import { useStore } from '@/store'
import { COMMANDS, GROUP_ORDER, type Command } from '@/lib/commands'
import type { DrawerTabState } from '@/store/slices/spindle-placement'
import styles from './CommandPalette.module.css'

/** Convert extension drawer tabs into Command objects so they appear in search. */
function extensionTabsToCommands(tabs: DrawerTabState[]): Command[] {
  return tabs.map((tab) => ({
    id: `ext-tab-${tab.id}`,
    label: tab.title,
    description: `Open extension tab`,
    icon: Puzzle,
    keywords: ['extension', 'spindle', tab.extensionId],
    group: 'Extensions' as const,
    run: () => useStore.getState().openDrawer(tab.id),
  }))
}

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
  const drawerTabs = useStore((s) => s.drawerTabs)
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const isComposing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset state each time the palette opens
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [isOpen])

  // Build filtered, available command list (static + extension tabs)
  const filtered = useMemo<Command[]>(() => {
    const allCommands = [...COMMANDS, ...extensionTabsToCommands(drawerTabs)]
    const available = allCommands.filter((cmd) => cmd.isAvailable?.() ?? true)
    if (!query.trim()) return available
    const q = query.toLowerCase()
    return available.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        cmd.keywords.some((k) => k.toLowerCase().includes(q))
    )
  }, [query, drawerTabs])

  // Clamp active index when filtered list shrinks
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)))
  }, [filtered.length])

  // Scroll active item into view on keyboard navigation
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Group the filtered results while preserving GROUP_ORDER
  const grouped = useMemo(() => {
    const map = new Map<Command['group'], Command[]>()
    for (const cmd of filtered) {
      const arr = map.get(cmd.group) ?? []
      arr.push(cmd)
      map.set(cmd.group, arr)
    }
    // Return in canonical order, skipping empty groups
    return GROUP_ORDER.flatMap((g) => {
      const cmds = map.get(g)
      return cmds?.length ? [{ group: g, cmds }] : []
    })
  }, [filtered])

  function execute(cmd: Command) {
    close()
    // Small timeout so the palette exit animation starts before any
    // state changes triggered by the command cause re-renders
    setTimeout(() => void cmd.run(navigate), 10)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposing.current) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[activeIndex]) execute(filtered[activeIndex])
        break
      case 'Escape':
        // Consume the event so drawer / other escape handlers don't fire
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'Tab':
        // Tab / Shift+Tab cycles through results without leaving the input
        e.preventDefault()
        if (e.shiftKey) {
          setActiveIndex((i) => Math.max(i - 1, 0))
        } else {
          setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
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
                aria-expanded={filtered.length > 0}
                aria-activedescendant={filtered[activeIndex] ? `cmd-${filtered[activeIndex].id}` : undefined}
                className={styles.input}
                placeholder="Search panels, settings, actions…"
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
              {filtered.length === 0 ? (
                <div className={styles.empty}>
                  No results for &ldquo;{query}&rdquo;
                </div>
              ) : (
                grouped.map(({ group, cmds }) => (
                  <div key={group} className={styles.group} role="group" aria-label={group}>
                    <div className={styles.groupLabel}>{group}</div>
                    {cmds.map((cmd) => {
                      const idx = filtered.indexOf(cmd)
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
                ))
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
