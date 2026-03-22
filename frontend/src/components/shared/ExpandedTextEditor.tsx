import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Minimize2, Maximize2, Hash, Search } from 'lucide-react'
import { getMacroCatalog } from '@/api/macros'
import { getAvailableMacros } from '@/lib/loom/service'
import type { MacroGroup } from '@/lib/loom/types'
import s from './ExpandedTextEditor.module.css'

// ============================================================================
// SYNTAX HIGHLIGHTING
// ============================================================================

function highlightSyntax(text: string): ReactNode[] {
  const tokens: ReactNode[] = []
  const regex = /(```[\s\S]*?```)|(\{\{[^}]*\}\})|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(^#{1,6}\s.+$)|(`[^`\n]+`)/gm
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index))
    }
    const m = match[0]
    if (match[1]) tokens.push(<span key={match.index} className={s.hlCode}>{m}</span>)
    else if (match[2]) tokens.push(<span key={match.index} className={s.hlMacro}>{m}</span>)
    else if (match[3]) tokens.push(<span key={match.index} className={s.hlBold}>{m}</span>)
    else if (match[4]) tokens.push(<span key={match.index} className={s.hlItalic}>{m}</span>)
    else if (match[5]) tokens.push(<span key={match.index} className={s.hlHeading}>{m}</span>)
    else if (match[6]) tokens.push(<span key={match.index} className={s.hlInlineCode}>{m}</span>)
    lastIndex = match.index + m.length
  }
  if (lastIndex < text.length) tokens.push(text.slice(lastIndex))
  return tokens
}

// ============================================================================
// EXPANDED TEXT EDITOR MODAL
// ============================================================================

interface ExpandedTextEditorProps {
  value: string
  onChange: (value: string) => void
  onClose: () => void
  title: string
  placeholder?: string
  initialCursorPos?: number | null
  macros?: MacroGroup[]
  onRefreshMacros?: () => void
}

export default function ExpandedTextEditor({
  value,
  onChange,
  onClose,
  title,
  placeholder,
  initialCursorPos,
  macros,
  onRefreshMacros,
}: ExpandedTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [showMacros, setShowMacros] = useState(false)
  const [macroSearch, setMacroSearch] = useState('')
  const [selfLoadedMacros, setSelfLoadedMacros] = useState<MacroGroup[] | null>(null)

  // Use caller-provided macros, or self-load on first toggle
  const resolvedMacros = macros ?? selfLoadedMacros ?? []

  const loadMacros = useCallback(() => {
    if (macros) { onRefreshMacros?.(); return }
    // Self-load: start with local fallback, then fetch from API
    if (!selfLoadedMacros) setSelfLoadedMacros(getAvailableMacros())
    getMacroCatalog()
      .then((catalog) => {
        const groups: MacroGroup[] = catalog.categories.map((c) => ({
          category: c.category,
          macros: c.macros.map((m) => ({ name: m.name, syntax: m.syntax, description: m.description, args: m.args, returns: m.returns })),
        }))
        const apiCategoryNames = new Set(groups.map((g) => g.category))
        const localOnly = getAvailableMacros().filter((g) => !apiCategoryNames.has(g.category))
        setSelfLoadedMacros([...groups, ...localOnly])
      })
      .catch(() => {})
  }, [macros, onRefreshMacros, selfLoadedMacros])

  const filteredMacros = useMemo(() => {
    if (!resolvedMacros.length) return []
    if (!macroSearch.trim()) return resolvedMacros
    const q = macroSearch.toLowerCase()
    return resolvedMacros.map(group => ({
      ...group,
      macros: group.macros.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.syntax.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q)),
    })).filter(g => g.macros.length > 0)
  }, [resolvedMacros, macroSearch])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    // Capture phase so we intercept before parent modal escape handlers
    document.addEventListener('keydown', handleEscape, true)
    document.body.style.overflow = 'hidden'

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        const pos = initialCursorPos ?? textareaRef.current.value.length
        textareaRef.current.selectionStart = pos
        textareaRef.current.selectionEnd = pos
      }
    })

    return () => {
      document.removeEventListener('keydown', handleEscape, true)
      document.body.style.overflow = ''
    }
  }, [])

  // Sync scroll between textarea and highlight overlay
  const handleScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  const insertMacro = useCallback((syntax: string) => {
    const ta = textareaRef.current
    if (!ta) { onChange(value + syntax); return }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    onChange(value.substring(0, start) + syntax + value.substring(end))
    setShowMacros(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = start + syntax.length
    })
  }, [value, onChange])

  const highlighted = useMemo(() => resolvedMacros.length > 0 ? highlightSyntax(value) : null, [value, resolvedMacros.length])

  return createPortal(
    <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={s.dialog} onClick={e => e.stopPropagation()}>
        <div className={s.header}>
          <div className={s.headerContent}>
            <h3 className={s.title}>{title}</h3>
            <button
              className={s.macroToggle}
              onClick={() => { if (!showMacros) loadMacros(); setShowMacros(!showMacros) }}
              type="button"
            >
              <Hash size={12} /> {showMacros ? 'Hide Macros' : 'Insert Macro'}
            </button>
          </div>
          <button className={s.closeBtn} onClick={onClose} title="Collapse editor" type="button">
            <Minimize2 size={18} />
          </button>
        </div>
        <div className={s.body}>
          {showMacros && (
            <div className={s.macroSidebar}>
              <div className={s.macroSearch}>
                <div className={s.macroSearchInner}>
                  <Search size={12} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
                  <input
                    className={s.macroSearchInput}
                    placeholder="Search macros..."
                    value={macroSearch}
                    onChange={e => setMacroSearch(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              <div className={s.macroList}>
                {filteredMacros.map(group => (
                  <div key={group.category} className={s.macroGroup}>
                    <div className={s.macroGroupTitle}>{group.category}</div>
                    {group.macros.map(macro => (
                      <div key={macro.syntax} className={s.macroItem} onClick={() => insertMacro(macro.syntax)}>
                        <span className={s.macroSyntax}>{macro.syntax}</span>
                        <span className={s.macroDesc}>{macro.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className={s.editorArea}>
            {highlighted ? (
              <div className={s.highlightContainer}>
                <div ref={highlightRef} className={s.highlightBackdrop} aria-hidden="true">
                  <pre className={s.highlightPre}>{highlighted}{'\n'}</pre>
                </div>
                <textarea
                  ref={textareaRef}
                  className={s.textareaHighlighted}
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  onScroll={handleScroll}
                  placeholder={placeholder}
                  spellCheck={false}
                />
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                className={s.textarea}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ============================================================================
// EXPANDABLE TEXTAREA WRAPPER
// ============================================================================

/**
 * Drop-in wrapper: renders the original textarea with an expand button overlay.
 * When expanded, opens a full-screen ExpandedTextEditor modal.
 */
export function ExpandableTextarea({
  value,
  onChange,
  title,
  placeholder,
  className,
  rows,
  spellCheck,
  macros,
  onRefreshMacros,
}: {
  value: string
  onChange: (value: string) => void
  title: string
  placeholder?: string
  className?: string
  rows?: number
  spellCheck?: boolean
  macros?: MacroGroup[]
  onRefreshMacros?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cursorPosRef = useRef<number | null>(null)

  const handleExpand = () => {
    cursorPosRef.current = textareaRef.current?.selectionStart ?? null
    setExpanded(true)
  }

  return (
    <div className={s.textareaWrapper}>
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={spellCheck}
      />
      <button
        className={s.expandBtn}
        onClick={handleExpand}
        title="Expand editor"
        type="button"
      >
        <Maximize2 size={13} />
      </button>
      {expanded && (
        <ExpandedTextEditor
          value={value}
          onChange={onChange}
          onClose={() => setExpanded(false)}
          title={title}
          placeholder={placeholder}
          initialCursorPos={cursorPosRef.current}
          macros={macros}
          onRefreshMacros={onRefreshMacros}
        />
      )}
    </div>
  )
}
