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
  let keyCounter = 0
  const k = () => keyCounter++

  /** Find position of first `}` in the balanced closing `}}` for a macro. */
  function findClose(str: string, start: number): number {
    let depth = 1
    let j = start
    while (j < str.length - 1 && depth > 0) {
      if (str[j] === '{' && str[j + 1] === '{') { depth++; j += 2 }
      else if (str[j] === '}' && str[j + 1] === '}') { depth--; if (depth === 0) return j; j += 2 }
      else j++
    }
    return -1
  }

  /** Highlight plain text (no macros): XML/HTML tags + Markdown syntax. */
  function highlightPlain(str: string): ReactNode[] {
    if (!str) return []
    const nodes: ReactNode[] = []
    // Combined single-pass regex: XML tags | bold+italic | bold | italic | strikethrough | code | header markers
    const re = /(<\/?[a-zA-Z_][\w.-]*(?:\s+[^>]*)?\s*\/?>)|\*\*\*(\S[^*]*?\S|\S)\*\*\*|\*\*(\S[^*]*?\S|\S)\*\*(?!\*)|(?<!\*)\*(?!\*|\s)(\S[^*]*?\S|\S)\*(?!\*)|~~(\S[\s\S]*?\S|\S)~~|`([^`\n]+)`|^(#{1,6})\s/gm
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) nodes.push(str.slice(last, m.index))

      if (m[1] != null) {
        // XML tag
        nodes.push(<span key={k()} className={s.hlXmlTag}>{m[0]}</span>)
      } else if (m[2] != null) {
        // Bold+italic ***...***
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'***'}</span>)
        nodes.push(m[2])
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'***'}</span>)
      } else if (m[3] != null) {
        // Bold **...**
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'**'}</span>)
        nodes.push(m[3])
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'**'}</span>)
      } else if (m[4] != null) {
        // Italic *...*
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'*'}</span>)
        nodes.push(m[4])
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'*'}</span>)
      } else if (m[5] != null) {
        // Strikethrough ~~...~~
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'~~'}</span>)
        nodes.push(m[5])
        nodes.push(<span key={k()} className={s.hlMdDelim}>{'~~'}</span>)
      } else if (m[6] != null) {
        // Inline code `...`
        nodes.push(<span key={k()} className={s.hlMdCode}>{m[0]}</span>)
      } else if (m[7] != null) {
        // Header marker (just the hashes)
        nodes.push(<span key={k()} className={s.hlMdHeader}>{m[7]}</span>)
        nodes.push(' ')
      }

      last = m.index + m[0].length
    }
    if (last < str.length) nodes.push(str.slice(last))
    return nodes
  }

  /** Process `::` separators and nested content inside a macro body. */
  function processArgs(str: string): ReactNode[] {
    const nodes: ReactNode[] = []
    let i = 0
    while (i < str.length) {
      // :: separator
      if (i < str.length - 1 && str[i] === ':' && str[i + 1] === ':') {
        nodes.push(<span key={k()} className={s.hlSep}>{'::'}</span>)
        i += 2
        continue
      }
      // Nested macro
      if (i < str.length - 1 && str[i] === '{' && str[i + 1] === '{') {
        const ci = findClose(str, i + 2)
        if (ci !== -1) {
          nodes.push(...emitMacro(str.slice(i + 2, ci)))
          i = ci + 2
          continue
        }
      }
      // Plain text within args
      const start = i
      while (i < str.length) {
        if (i < str.length - 1 && ((str[i] === ':' && str[i + 1] === ':') || (str[i] === '{' && str[i + 1] === '{'))) break
        i++
      }
      if (i > start) nodes.push(...highlightPlain(str.slice(start, i)))
    }
    return nodes
  }

  /** Emit a single macro: brackets + name + args. `inner` is content between {{ and }}. */
  function emitMacro(inner: string): ReactNode[] {
    const nodes: ReactNode[] = []
    nodes.push(<span key={k()} className={s.hlBracket}>{'{{'}</span>)
    const nameMatch = inner.match(/^([a-zA-Z_]\w*)/)
    if (nameMatch) {
      nodes.push(<span key={k()} className={s.hlMacroName}>{nameMatch[1]}</span>)
      const rest = inner.slice(nameMatch[1].length)
      if (rest.length > 0) nodes.push(...processArgs(rest))
    } else {
      nodes.push(...processArgs(inner))
    }
    nodes.push(<span key={k()} className={s.hlBracket}>{'}}'}</span>)
    return nodes
  }

  /** Top-level: split on macros, highlight plain segments with XML tags. */
  const result: ReactNode[] = []
  let i = 0
  while (i < text.length) {
    if (i < text.length - 1 && text[i] === '{' && text[i + 1] === '{') {
      const ci = findClose(text, i + 2)
      if (ci !== -1) {
        result.push(...emitMacro(text.slice(i + 2, ci)))
        i = ci + 2
        continue
      }
    }
    const start = i
    while (i < text.length && !(i < text.length - 1 && text[i] === '{' && text[i + 1] === '{')) i++
    if (i > start) result.push(...highlightPlain(text.slice(start, i)))
  }
  return result
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
  inline?: boolean
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
  inline,
}: ExpandedTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const overlayMouseDownRef = useRef<EventTarget | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [showMacros, setShowMacros] = useState(false)
  const [macroSearch, setMacroSearch] = useState('')
  const [selfLoadedMacros, setSelfLoadedMacros] = useState<MacroGroup[] | null>(
    () => macros ? null : getAvailableMacros(),
  )

  // Use caller-provided macros, or eagerly-loaded local catalog
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
    if (!inline) document.body.style.overflow = 'hidden'

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        const pos = initialCursorPos ?? textareaRef.current.value.length
        textareaRef.current.setSelectionRange(pos, pos)
      }
    })

    return () => {
      document.removeEventListener('keydown', handleEscape, true)
      if (!inline) document.body.style.overflow = ''
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
      const pos = start + syntax.length
      ta.setSelectionRange(pos, pos)
    })
  }, [value, onChange])

  // Debounce syntax highlighting — it's purely visual and expensive to run
  // synchronously on every keystroke (especially during rapid deletion).
  const [highlighted, setHighlighted] = useState<ReactNode[] | null>(null)
  useEffect(() => {
    if (resolvedMacros.length === 0) {
      setHighlighted(null)
      return
    }
    const timer = setTimeout(() => {
      setHighlighted(highlightSyntax(value))
    }, 150)
    return () => clearTimeout(timer)
  }, [value, resolvedMacros.length])

  const editorContent = (
    <div className={inline ? s.inlineDialog : s.dialog} onClick={e => e.stopPropagation()}>
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
  )

  if (inline) return editorContent

  return createPortal(
    <div
      className={s.overlay}
      onMouseDown={(e) => { overlayMouseDownRef.current = e.target }}
      onClick={(e) => { if (e.target === e.currentTarget && overlayMouseDownRef.current === e.currentTarget) onClose() }}
    >
      {editorContent}
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

  // Track cursor position continuously so it's correct even after
  // the expand button steals focus via mousedown before click fires
  const handleSelect = useCallback(() => {
    cursorPosRef.current = textareaRef.current?.selectionStart ?? cursorPosRef.current
  }, [])

  const handleExpand = () => {
    setExpanded(true)
  }

  return (
    <div className={s.textareaWrapper}>
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={handleSelect}
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
