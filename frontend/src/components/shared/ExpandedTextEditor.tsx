import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useLayoutEffect,
  forwardRef,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type ReactNode,
  type SyntheticEvent,
  type TextareaHTMLAttributes,
} from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Minimize2, Maximize2, Hash, Search, Replace as ReplaceIcon, ChevronUp, ChevronDown, X } from 'lucide-react'
import { getMacroCatalog } from '@/api/macros'
import { getAvailableMacros } from '@/lib/loom/service'
import type { MacroGroup } from '@/lib/loom/types'
import {
  findExpandedTextMatches,
  replaceAllExpandedTextMatches,
  replaceExpandedTextMatch,
  type ExpandedTextMatch,
} from '@/lib/expandedTextSearch'
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
        // Unclosed nested macro — emit remainder as plain text to avoid infinite loop
        nodes.push(...highlightPlain(str.slice(i)))
        i = str.length
        continue
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
      // Unclosed macro — emit remainder as plain text to avoid infinite loop
      result.push(...highlightPlain(text.slice(i)))
      i = text.length
      continue
    }
    const start = i
    while (i < text.length && !(i < text.length - 1 && text[i] === '{' && text[i + 1] === '{')) i++
    if (i > start) result.push(...highlightPlain(text.slice(start, i)))
  }
  return result
}

function highlightFindMatches(
  text: string,
  matches: ExpandedTextMatch[],
  currentIndex: number,
): ReactNode[] {
  if (matches.length === 0) return [text]
  const nodes: ReactNode[] = []
  let offset = 0
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    if (match.start > offset) nodes.push(text.slice(offset, match.start))
    nodes.push(
      <mark
        key={`${match.start}-${match.end}`}
        className={index === currentIndex ? s.findMatchCurrent : s.findMatch}
        data-find-current={index === currentIndex ? 'true' : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    )
    offset = match.end
  }
  if (offset < text.length) nodes.push(text.slice(offset))
  return nodes
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
  /**
   * Render the syntax-highlight overlay (markdown + XML) without a macro
   * catalog. Also hides the macro toggle. Use for free-text content that
   * isn't a prompt template — e.g. databank document bodies.
   */
  markdownOnly?: boolean
}

type TextSelectionDirection = 'forward' | 'backward' | 'none'

interface TextSelectionSnapshot {
  start: number
  end: number
  direction: TextSelectionDirection
}

function normalizeSelectionDirection(direction: HTMLTextAreaElement['selectionDirection']): TextSelectionDirection {
  return direction === 'forward' || direction === 'backward' ? direction : 'none'
}

function clampSelection(selection: TextSelectionSnapshot, valueLength: number): TextSelectionSnapshot {
  const start = Math.max(0, Math.min(selection.start, valueLength))
  const end = Math.max(0, Math.min(selection.end, valueLength))
  return start <= end
    ? { start, end, direction: selection.direction }
    : { start: end, end: start, direction: selection.direction }
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
  markdownOnly,
}: ExpandedTextEditorProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'expandedTextEditor' })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const overlayMouseDownRef = useRef<EventTarget | null>(null)
  const onCloseRef = useRef(onClose)
  const selectionRef = useRef<TextSelectionSnapshot | null>(null)
  const hasInitializedSelectionRef = useRef(false)
  const shouldRestoreSelectionRef = useRef(true)
  const shouldFocusSelectionRef = useRef(true)
  const isComposingRef = useRef(false)
  const findModeRef = useRef<'find' | 'replace' | null>(null)
  const findQueryRef = useRef('')
  const lastScrolledMatchNavigationRequestRef = useRef(0)
  const macroSearchRef = useRef('')
  const showMacrosRef = useRef(false)
  onCloseRef.current = onClose

  const [showMacros, setShowMacros] = useState(false)
  const [macroSearch, setMacroSearch] = useState('')
  const [findMode, setFindMode] = useState<'find' | 'replace' | null>(null)
  const [findQuery, setFindQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const [matchNavigationRequest, setMatchNavigationRequest] = useState(0)
  const [selfLoadedMacros, setSelfLoadedMacros] = useState<MacroGroup[] | null>(
    () => (macros || markdownOnly) ? null : getAvailableMacros(),
  )

  // Use caller-provided macros, or eagerly-loaded local catalog
  const resolvedMacros = useMemo(() => macros ?? selfLoadedMacros ?? [], [macros, selfLoadedMacros])
  findModeRef.current = findMode
  findQueryRef.current = findQuery
  macroSearchRef.current = macroSearch
  showMacrosRef.current = showMacros

  const findMatches = useMemo(
    () => findExpandedTextMatches(value, findQuery),
    [findQuery, value],
  )

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

  const captureSelection = useCallback((target: HTMLTextAreaElement | null) => {
    if (!target) return
    selectionRef.current = {
      start: target.selectionStart,
      end: target.selectionEnd,
      direction: normalizeSelectionDirection(target.selectionDirection),
    }
  }, [])

  const restoreSelection = useCallback(() => {
    const textarea = textareaRef.current
    const selection = selectionRef.current
    if (!textarea || !selection || isComposingRef.current) return

    const nextSelection = clampSelection(selection, textarea.value.length)
    selectionRef.current = nextSelection

    if (shouldFocusSelectionRef.current && document.activeElement !== textarea) {
      textarea.focus()
    }

    const currentDirection = normalizeSelectionDirection(textarea.selectionDirection)
    if (
      textarea.selectionStart !== nextSelection.start ||
      textarea.selectionEnd !== nextSelection.end ||
      currentDirection !== nextSelection.direction
    ) {
      textarea.setSelectionRange(nextSelection.start, nextSelection.end, nextSelection.direction)
    }

    shouldRestoreSelectionRef.current = false
    shouldFocusSelectionRef.current = false
  }, [])

  const setMatchSelection = useCallback((match: ExpandedTextMatch | undefined) => {
    if (!match) return
    selectionRef.current = { start: match.start, end: match.end, direction: 'forward' }
    shouldRestoreSelectionRef.current = true
    shouldFocusSelectionRef.current = false
    const textarea = textareaRef.current
    if (textarea) textarea.setSelectionRange(match.start, match.end, 'forward')
  }, [])

  const goToMatch = useCallback((nextIndex: number) => {
    if (findMatches.length === 0) return
    const normalized = (nextIndex + findMatches.length) % findMatches.length
    setCurrentMatchIndex(normalized)
    setMatchNavigationRequest((request) => request + 1)
    setMatchSelection(findMatches[normalized])
  }, [findMatches, setMatchSelection])

  const replaceCurrentMatch = useCallback(() => {
    const match = findMatches[currentMatchIndex]
    if (!match) return
    const nextValue = replaceExpandedTextMatch(value, match, replacement)
    const nextMatches = findExpandedTextMatches(nextValue, findQuery)
    const nextOffset = match.start + replacement.length
    let nextIndex = nextMatches.findIndex((candidate) => candidate.start >= nextOffset)
    if (nextIndex === -1) nextIndex = 0
    setCurrentMatchIndex(nextIndex)
    selectionRef.current = nextMatches[nextIndex]
      ? { ...nextMatches[nextIndex], direction: 'forward' }
      : { start: nextOffset, end: nextOffset, direction: 'none' }
    shouldRestoreSelectionRef.current = true
    shouldFocusSelectionRef.current = false
    onChange(nextValue)
  }, [currentMatchIndex, findMatches, findQuery, onChange, replacement, value])

  const replaceAllMatches = useCallback(() => {
    if (findMatches.length === 0) return
    const nextValue = replaceAllExpandedTextMatches(value, findMatches, replacement)
    selectionRef.current = { start: 0, end: 0, direction: 'none' }
    shouldRestoreSelectionRef.current = true
    shouldFocusSelectionRef.current = false
    setCurrentMatchIndex(0)
    onChange(nextValue)
  }, [findMatches, onChange, replacement, value])

  useEffect(() => {
    if (!findMode) return
    const frame = requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [findMode])

  useEffect(() => {
    setCurrentMatchIndex((index) => findMatches.length === 0 ? 0 : Math.min(index, findMatches.length - 1))
  }, [findMatches.length])

  useEffect(() => {
    // Editing text or the query recalculates the matches. Keep the viewport in
    // place for those updates; only an explicit next/previous navigation moves it.
    if (matchNavigationRequest === lastScrolledMatchNavigationRequestRef.current) return
    lastScrolledMatchNavigationRequestRef.current = matchNavigationRequest
    if (findMatches.length === 0) return
    const frame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('[data-find-current="true"]')
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [currentMatchIndex, findMatches, matchNavigationRequest])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    if (!hasInitializedSelectionRef.current) {
      const initialPos = Math.max(0, Math.min(initialCursorPos ?? textarea.value.length, textarea.value.length))
      selectionRef.current = { start: initialPos, end: initialPos, direction: 'none' }
      hasInitializedSelectionRef.current = true
      shouldRestoreSelectionRef.current = true
      shouldFocusSelectionRef.current = true
    } else if (document.activeElement === textarea || shouldFocusSelectionRef.current) {
      shouldRestoreSelectionRef.current = true
    }

    if (!shouldRestoreSelectionRef.current || isComposingRef.current) return
    restoreSelection()
  }, [initialCursorPos, restoreSelection, value])

  useEffect(() => {
    const handleEditorShortcut = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        if (findModeRef.current === 'find') {
          findInputRef.current?.focus()
          findInputRef.current?.select()
        } else {
          setFindMode('find')
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'h') {
        e.preventDefault()
        e.stopPropagation()
        if (findModeRef.current === 'replace') {
          findInputRef.current?.focus()
          findInputRef.current?.select()
        } else {
          setFindMode('replace')
        }
        return
      }
      if (e.key !== 'Escape') return

      e.preventDefault()
      e.stopPropagation()
      if (findModeRef.current && findQueryRef.current) {
        setFindQuery('')
        setCurrentMatchIndex(0)
      } else if (findModeRef.current) {
        setFindMode(null)
      } else if (showMacrosRef.current && macroSearchRef.current) {
        setMacroSearch('')
      } else {
        onCloseRef.current()
      }
    }
    // Capture phase so we intercept before parent modal escape handlers
    document.addEventListener('keydown', handleEditorShortcut, true)
    if (!inline) document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEditorShortcut, true)
      if (!inline) document.body.style.overflow = ''
    }
  }, [inline])

  const handleTextareaChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    captureSelection(e.currentTarget)
    shouldRestoreSelectionRef.current = true
    onChange(e.currentTarget.value)
  }, [captureSelection, onChange])

  const handleTextareaSelect = useCallback((e: SyntheticEvent<HTMLTextAreaElement>) => {
    captureSelection(e.currentTarget)
  }, [captureSelection])

  const handleCompositionStart = useCallback((e: CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = true
    captureSelection(e.currentTarget)
  }, [captureSelection])

  const handleCompositionEnd = useCallback((e: CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false
    captureSelection(e.currentTarget)
    shouldRestoreSelectionRef.current = true
  }, [captureSelection])

  const replaceSelection = useCallback((
    insertedText: string,
    opts?: {
      target?: HTMLTextAreaElement | null
      focus?: boolean
      appendIfMissing?: boolean
    },
  ) => {
    const target = opts?.target ?? textareaRef.current
    if (!target) {
      const nextValue = opts?.appendIfMissing === false ? value : value + insertedText
      selectionRef.current = {
        start: nextValue.length,
        end: nextValue.length,
        direction: 'none',
      }
      shouldRestoreSelectionRef.current = true
      shouldFocusSelectionRef.current = opts?.focus ?? true
      onChange(nextValue)
      return
    }

    const start = target.selectionStart
    const end = target.selectionEnd
    const nextValue = value.substring(0, start) + insertedText + value.substring(end)
    selectionRef.current = {
      start: start + insertedText.length,
      end: start + insertedText.length,
      direction: 'none',
    }
    shouldRestoreSelectionRef.current = true
    shouldFocusSelectionRef.current = opts?.focus ?? document.activeElement !== target
    onChange(nextValue)
  }, [onChange, value])

  const handleTextareaKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key !== 'Tab' ||
      e.shiftKey ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      isComposingRef.current
    ) {
      return
    }

    e.preventDefault()
    replaceSelection('\t', { target: e.currentTarget, focus: false })
  }, [replaceSelection])

  const insertMacro = useCallback((syntax: string) => {
    replaceSelection(syntax, { focus: true })
    setShowMacros(false)
  }, [replaceSelection])

  const closeFindPanel = useCallback(() => {
    setFindMode(null)
    setFindQuery('')
    setCurrentMatchIndex(0)
  }, [])

  const toggleFindPanel = useCallback((mode: 'find' | 'replace') => {
    if (findMode === mode) closeFindPanel()
    else setFindMode(mode)
  }, [closeFindPanel, findMode])

  const hasMacros = resolvedMacros.length > 0
  const showHighlight = hasMacros || !!markdownOnly || !!findQuery
  const highlightNodes = useMemo(
    () => !showHighlight
      ? null
      : findQuery
        ? highlightFindMatches(value, findMatches, currentMatchIndex)
        : highlightSyntax(value),
    [currentMatchIndex, findMatches, findQuery, showHighlight, value],
  )

  const editorContent = (
    <div ref={dialogRef} className={inline ? s.inlineDialog : s.dialog} onClick={e => e.stopPropagation()}>
      <div className={s.header}>
        <div className={s.headerContent}>
          <h3 className={s.title}>{title}</h3>
          <div className={s.toolbar}>
            {!markdownOnly && (
              <button
                className={s.toolbarBtn}
                onClick={() => { if (!showMacros) loadMacros(); setShowMacros(!showMacros) }}
                type="button"
              >
                <Hash size={12} /> {showMacros ? t('hideMacros') : t('insertMacro')}
              </button>
            )}
            <button
              className={`${s.toolbarBtn} ${findMode === 'find' ? s.toolbarBtnActive : ''}`}
              onClick={() => toggleFindPanel('find')}
              type="button"
              aria-expanded={findMode === 'find'}
            >
              <Search size={12} /> {t('find')}
            </button>
            <button
              className={`${s.toolbarBtn} ${findMode === 'replace' ? s.toolbarBtnActive : ''}`}
              onClick={() => toggleFindPanel('replace')}
              type="button"
              aria-expanded={findMode === 'replace'}
            >
              <ReplaceIcon size={12} /> {t('findAndReplace')}
            </button>
          </div>
        </div>
        <button className={s.closeBtn} onClick={onClose} title={t('collapseEditor')} type="button">
          <Minimize2 size={18} />
        </button>
      </div>
      {findMode && (
        <div className={s.findPanel}>
          <div className={s.findRow}>
            <Search size={13} className={s.findIcon} />
            <input
              ref={findInputRef}
              className={s.findInput}
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value)
                setCurrentMatchIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  goToMatch(currentMatchIndex + (event.shiftKey ? -1 : 1))
                }
              }}
              placeholder={t('findPlaceholder')}
              aria-label={t('find')}
            />
            {findQuery && (
              <button
                type="button"
                className={s.findIconBtn}
                onClick={() => {
                  setFindQuery('')
                  setCurrentMatchIndex(0)
                  findInputRef.current?.focus()
                }}
                title={t('clearFind')}
                aria-label={t('clearFind')}
              >
                <X size={12} />
              </button>
            )}
            <span className={s.matchCount} aria-live="polite">
              {findMatches.length === 0 ? '0/0' : `${currentMatchIndex + 1}/${findMatches.length}`}
            </span>
            <button
              type="button"
              className={s.findIconBtn}
              onClick={() => goToMatch(currentMatchIndex - 1)}
              disabled={findMatches.length === 0}
              title={t('previousMatch')}
              aria-label={t('previousMatch')}
            >
              <ChevronUp size={13} />
            </button>
            <button
              type="button"
              className={s.findIconBtn}
              onClick={() => goToMatch(currentMatchIndex + 1)}
              disabled={findMatches.length === 0}
              title={t('nextMatch')}
              aria-label={t('nextMatch')}
            >
              <ChevronDown size={13} />
            </button>
            <button
              type="button"
              className={s.findIconBtn}
              onClick={closeFindPanel}
              title={t('closeFind')}
              aria-label={t('closeFind')}
            >
              <X size={13} />
            </button>
          </div>
          {findMode === 'replace' && (
            <div className={s.replaceRow}>
              <ReplaceIcon size={13} className={s.findIcon} />
              <input
                className={s.findInput}
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    replaceCurrentMatch()
                  }
                }}
                placeholder={t('replacePlaceholder')}
                aria-label={t('replaceWith')}
              />
              <button
                type="button"
                className={s.replaceBtn}
                onClick={replaceCurrentMatch}
                disabled={findMatches.length === 0}
              >
                {t('replace')}
              </button>
              <button
                type="button"
                className={s.replaceBtn}
                onClick={replaceAllMatches}
                disabled={findMatches.length === 0}
              >
                {t('replaceAll')}
              </button>
            </div>
          )}
        </div>
      )}
      <div className={s.body}>
        {showMacros && (
          <div className={s.macroSidebar}>
            <div className={s.macroSearch}>
              <div className={s.macroSearchInner}>
                <Search size={12} style={{ color: 'var(--lumiverse-text-dim)', flexShrink: 0 }} />
                <input
                  className={s.macroSearchInput}
                  placeholder={t('searchMacros')}
                  value={macroSearch}
                  onChange={e => setMacroSearch(e.target.value)}
                  autoFocus
                />
                {macroSearch && (
                  <button
                    type="button"
                    className={s.macroSearchClear}
                    onClick={() => setMacroSearch('')}
                    aria-label={t('clearMacroSearch')}
                  >
                    <X size={12} />
                  </button>
                )}
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
          {showHighlight ? (
            <div className={s.highlightContainer}>
              <div className={s.highlightInner}>
                <pre className={s.highlightPre} aria-hidden="true">{highlightNodes}{'\n'}</pre>
                <textarea
                  ref={textareaRef}
                  className={s.textareaHighlighted}
                  value={value}
                  onChange={handleTextareaChange}
                  onSelect={handleTextareaSelect}
                  onKeyDown={handleTextareaKeyDown}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  placeholder={placeholder}
                  spellCheck={false}
                />
              </div>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className={s.textarea}
              value={value}
              onChange={handleTextareaChange}
              onSelect={handleTextareaSelect}
              onKeyDown={handleTextareaKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
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
interface ExpandableTextareaProps extends Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'aria-label'> {
  value: string
  onChange: (value: string) => void
  title: string
  placeholder?: string
  className?: string
  rows?: number
  spellCheck?: boolean
  macros?: MacroGroup[]
  onRefreshMacros?: () => void
  /** Forwarded to the full-screen editor. See ExpandedTextEditor.markdownOnly. */
  markdownOnly?: boolean
}

function assignTextareaRef(ref: Ref<HTMLTextAreaElement> | undefined, node: HTMLTextAreaElement | null) {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(node)
    return
  }
  ref.current = node
}

export const ExpandableTextarea = forwardRef<HTMLTextAreaElement, ExpandableTextareaProps>(function ExpandableTextarea({
  value,
  onChange,
  title,
  placeholder,
  className,
  rows,
  spellCheck,
  macros,
  onRefreshMacros,
  markdownOnly,
  name,
  'aria-label': ariaLabel,
}, forwardedRef) {
  const { t } = useTranslation('shared', { keyPrefix: 'expandedTextEditor' })
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cursorPosRef = useRef<number | null>(null)

  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
    assignTextareaRef(forwardedRef, node)
  }, [forwardedRef])

  // Track cursor position continuously so it's correct even after
  // the expand button steals focus via mousedown before click fires
  const handleSelect = useCallback(() => {
    cursorPosRef.current = textareaRef.current?.selectionStart ?? cursorPosRef.current
  }, [])

  const handleTextareaChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    cursorPosRef.current = e.currentTarget.selectionStart
    onChange(e.currentTarget.value)
  }, [onChange])

  const handleExpand = () => {
    setExpanded(true)
  }

  return (
    <div className={s.textareaWrapper}>
      <textarea
        ref={setTextareaRef}
        className={className}
        value={value}
        onChange={handleTextareaChange}
        onSelect={handleSelect}
        placeholder={placeholder}
        rows={rows}
        spellCheck={spellCheck}
        name={name}
        aria-label={ariaLabel}
      />
      <button
        className={s.expandBtn}
        onClick={handleExpand}
        title={t('expandEditor')}
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
          markdownOnly={markdownOnly}
        />
      )}
    </div>
  )
})
