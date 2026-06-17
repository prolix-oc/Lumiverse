import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import styles from './SearchableSelect.module.css'

export interface SearchableSelectOption {
  value: string
  label: string
  sublabel?: string
  /** Optional leading node (avatar, icon, swatch) rendered before the label in both the trigger and the option row. */
  leading?: ReactNode
  disabled?: boolean
  /** Optional grouping key. Options sharing a group render under a shared header. Empty/undefined folds into "Uncategorized". Headers auto-hide when no option in the group matches the current search. */
  group?: string
}

const UNCATEGORIZED_KEY = '__uncategorized__'

function getGroupKey(opt: SearchableSelectOption): string {
  const trimmed = (opt.group ?? '').trim()
  return trimmed || UNCATEGORIZED_KEY
}

type SingleModeProps = {
  multi?: false
  value: string
  onChange: (value: string) => void
  /** Show a "None" / clear option at the top of the list (single-select only). */
  clearable?: boolean
  clearLabel?: string
}

type MultiModeProps = {
  multi: true
  value: string[]
  onChange: (value: string[]) => void
}

type CommonProps = {
  options: SearchableSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  /** Hide the search input when options are at or below this count. Default 8. */
  searchThreshold?: number
  emptyMessage?: string
  noResultsMessage?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  triggerIcon?: ReactNode
  /** Force a specific trigger label (e.g. "+ Add"), ignoring current selection. */
  triggerLabel?: string
  /** Show the selected option's sublabel as a second line in the trigger (single-select). */
  showSelectedSublabel?: boolean
  /** Extra class on the leading slot (trigger + rows). */
  leadingClassName?: string
  ariaLabel?: string
  /** Render the popover inside document.body (useful for overflow-hidden containers). */
  portal?: boolean
  /** Horizontal alignment of popover relative to trigger. Default 'left'. */
  align?: 'left' | 'right'
  /** Max height of the popover in px. Default 280. */
  maxHeight?: number
  /** Min width of the popover in px. Default matches trigger width. */
  minWidth?: number
}

type SearchableSelectProps = CommonProps & (SingleModeProps | MultiModeProps)

export default function SearchableSelect(props: SearchableSelectProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'searchableSelect' })

  const {
    options,
    placeholder = t('placeholder'),
    searchPlaceholder = t('searchPlaceholder'),
    searchThreshold = 8,
    emptyMessage = t('emptyMessage'),
    noResultsMessage = t('noResultsMessage'),
    disabled,
    className,
    triggerClassName,
    triggerIcon,
    triggerLabel,
    showSelectedSublabel,
    leadingClassName,
    ariaLabel,
    portal = false,
    align = 'left',
    maxHeight = 280,
    minWidth,
  } = props

  const isMulti = props.multi === true

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number | null; bottom: number | null; left: number; width: number; maxHeight: number } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = search.trim().toLowerCase()
  const hasGroups = useMemo(
    () => options.some((o) => (o.group ?? '').trim().length > 0),
    [options],
  )
  const filtered = useMemo(() => {
    const base = needle
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            (o.sublabel && o.sublabel.toLowerCase().includes(needle)),
        )
      : options
    if (!hasGroups) return base
    // Group-sort: alphabetize buckets, Uncategorized last. Preserve input order inside each bucket.
    const buckets = new Map<string, SearchableSelectOption[]>()
    for (const opt of base) {
      const key = getGroupKey(opt)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(opt)
      else buckets.set(key, [opt])
    }
    const namedKeys = Array.from(buckets.keys())
      .filter((k) => k !== UNCATEGORIZED_KEY)
      .sort((a, b) => a.localeCompare(b))
    const orderedKeys = buckets.has(UNCATEGORIZED_KEY)
      ? [...namedKeys, UNCATEGORIZED_KEY]
      : namedKeys
    return orderedKeys.flatMap((k) => buckets.get(k)!)
  }, [options, needle, hasGroups])

  const isSelected = useCallback(
    (v: string) =>
      isMulti ? (props.value as string[]).includes(v) : props.value === v,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMulti, props.value],
  )

  const toggleValue = useCallback(
    (v: string) => {
      if (isMulti) {
        const cur = props.value as string[]
        const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
        ;(props.onChange as (value: string[]) => void)(next)
      } else {
        // Match native <select>: re-picking the selected option is not a change.
        if (v !== props.value) (props.onChange as (value: string) => void)(v)
        setOpen(false)
        setSearch('')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMulti, props.onChange, props.value],
  )

  const clearValue = useCallback(() => {
    if (isMulti) return
    ;(props.onChange as (value: string) => void)('')
    setOpen(false)
    setSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMulti, props.onChange])

  // Tracks the last window/visualViewport resize so the outside-click handler
  // can suppress dismissals while the Android soft keyboard is actively
  // presenting (a transition that can last 300–500ms, well past the 100ms
  // openedAt guard). See outside-click effect below.
  const lastViewportChangeRef = useRef(0)

  // Close on outside pointer-down. `pointerdown` (not `mousedown`) is the
  // unified event for mouse/touch/pen. Portal-mode popovers are detached
  // from the trigger's DOM subtree, which makes them vulnerable to several
  // Android-specific hazards that the inline variant naturally dodges:
  //  - Synthetic pointerdowns with `target = document/<html>/<body>` are
  //    dispatched during viewport transitions; those land outside *both*
  //    refs and would otherwise dismiss.
  //  - Android keyboard presentation takes 300–500ms, which blows past the
  //    100ms openedAt grace. Suppress closes while a viewport change is
  //    still propagating.
  //  - `e.target` is sometimes reported as an ancestor of the real tap
  //    point when an event passes through a portal boundary, so also
  //    hit-test via `composedPath()`.
  useEffect(() => {
    if (!open) return
    const openedAt = performance.now()
    const handle = (e: PointerEvent) => {
      if (!e.isTrusted) return
      if (performance.now() - openedAt < 100) return
      if (performance.now() - lastViewportChangeRef.current < 350) return
      const target = e.target as Node | null
      if (!target) return
      if (
        target === document ||
        target === document.documentElement ||
        target === document.body
      ) return
      const path = typeof e.composedPath === 'function' ? e.composedPath() : []
      const trigger = triggerRef.current
      const popover = popoverRef.current
      const inTrigger = !!trigger && (trigger.contains(target) || path.includes(trigger))
      const inPopover = !!popover && (popover.contains(target) || path.includes(popover))
      if (!inTrigger && !inPopover) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('pointerdown', handle)
    return () => document.removeEventListener('pointerdown', handle)
  }, [open])

  const reposition = useCallback(() => {
    if (!triggerRef.current) return
    // `body > *` carries `zoom: var(--lumiverse-ui-scale)` (see theme/reset.css), so
    // any portaled popover is rendered inside a zoomed layout context. getBoundingClientRect
    // returns post-zoom (rendered) coords, but the inline `top/left` we set are interpreted
    // in pre-zoom (layout) space — without compensating, the popover drifts off the trigger
    // and can slide partly off the viewport at scales >= 1.10.
    const uiScale = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
    ) || 1
    const r = triggerRef.current.getBoundingClientRect()
    // r.width is rendered; minWidth is specified in design units (pre-zoom).
    const layoutWidth = Math.max(r.width / uiScale, minWidth ?? 240)
    const renderedWidth = layoutWidth * uiScale
    let renderedLeft = align === 'right' ? r.right - renderedWidth : r.left
    // Clamp horizontally so the popover stays on screen at any UI scale.
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    const gap = 4
    if (renderedLeft + renderedWidth > vw - margin) {
      renderedLeft = vw - margin - renderedWidth
    }
    if (renderedLeft < margin) {
      renderedLeft = margin
    }
    // Flip above when there's more room there, capping height to the available
    // space. Flipped popovers anchor via `bottom` so a short list hugs the trigger.
    const desired = maxHeight * uiScale
    const spaceBelow = vh - r.bottom - margin - gap
    const spaceAbove = r.top - margin - gap
    const placeAbove = spaceBelow < desired && spaceAbove > spaceBelow
    const renderedMaxHeight = Math.max(120, Math.min(desired, placeAbove ? spaceAbove : spaceBelow))
    // On tiny viewports the 120px floor can exceed spaceAbove; lower the anchor
    // so the focused search input stays on-screen.
    const renderedBottom = placeAbove
      ? Math.min(vh - r.top + gap, Math.max(margin, vh - margin - renderedMaxHeight))
      : null
    setPos({
      top: placeAbove ? null : (r.bottom + gap) / uiScale,
      bottom: renderedBottom === null ? null : renderedBottom / uiScale,
      left: renderedLeft / uiScale,
      width: layoutWidth,
      maxHeight: renderedMaxHeight / uiScale,
    })
  }, [align, minWidth, maxHeight])

  // Reposition rather than close on scroll/resize: focusing the search input
  // (mobile keyboard opens → viewport resize) or scrollIntoView inside the
  // option list would otherwise dismiss the popover the instant it opened.
  // Scrolls that originate inside the popover are ignored so the internal
  // option list can scroll freely. Resize is also tracked unconditionally
  // so the outside-click handler's keyboard-transition grace window works
  // for non-portal popovers too.
  useEffect(() => {
    if (!open) return
    const handleScroll = (e: Event) => {
      if (!portal) return
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      reposition()
    }
    const handleResize = () => {
      lastViewportChangeRef.current = performance.now()
      if (portal) reposition()
    }
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [open, portal, reposition])

  useLayoutEffect(() => {
    if (!open || !portal) return
    reposition()
  }, [open, portal, reposition])

  // Focus search input when opened
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Reset hover index when filter or open state changes
  useEffect(() => {
    setActiveIdx(0)
  }, [needle, open])

  // Scroll active option into view
  useEffect(() => {
    if (!open) return
    const el = popoverRef.current?.querySelector(
      `[data-opt-idx="${activeIdx}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setSearch('')
        triggerRef.current?.focus()
      }
      return
    }

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIdx]
      if (opt && !opt.disabled) toggleValue(opt.value)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const selectedOption = useMemo(
    () => (isMulti ? undefined : options.find((o) => o.value === (props.value as string))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMulti, options, props.value],
  )

  const renderLabel = (): { text: string; isPlaceholder: boolean } => {
    if (triggerLabel !== undefined) return { text: triggerLabel, isPlaceholder: false }
    if (isMulti) {
      const count = (props.value as string[]).length
      return count === 0
        ? { text: placeholder, isPlaceholder: true }
        : { text: `${count} selected`, isPlaceholder: false }
    }
    return selectedOption
      ? { text: selectedOption.label, isPlaceholder: false }
      : { text: placeholder, isPlaceholder: true }
  }

  const label = renderLabel()
  const showSearch = options.length > searchThreshold

  const popover = (
    <div
      ref={popoverRef}
      className={clsx(styles.popover, portal && styles.popoverPortal)}
      role="listbox"
      aria-multiselectable={isMulti || undefined}
      style={{
        maxHeight: portal && pos ? pos.maxHeight : maxHeight,
        ...(portal && pos
          ? { top: pos.top ?? 'auto', bottom: pos.bottom ?? 'auto', left: pos.left, width: pos.width }
          : {}),
      }}
    >
      {showSearch && (
        <div className={styles.searchRow}>
          <Search size={12} className={styles.searchIcon} aria-hidden />
          <input
            ref={searchRef}
            type="text"
            className={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={searchPlaceholder}
          />
        </div>
      )}
      <div className={styles.optionList}>
        {!isMulti && 'clearable' in props && props.clearable && (
          <button
            type="button"
            className={clsx(styles.option, props.value === '' && styles.optionActive)}
            onClick={clearValue}
          >
            <span className={styles.optionCheck}>{props.value === '' ? '✓' : ''}</span>
            <span className={styles.optionLabel}>{props.clearLabel ?? t('clear')}</span>
          </button>
        )}
        {filtered.length === 0 ? (
          <div className={styles.emptyMessage}>
            {options.length === 0 ? emptyMessage : noResultsMessage}
          </div>
        ) : (
          (() => {
            let lastGroupKey: string | null = null
            const nodes: ReactNode[] = []
            filtered.forEach((opt, i) => {
              if (hasGroups) {
                const key = getGroupKey(opt)
                if (key !== lastGroupKey) {
                  const headerLabel = key === UNCATEGORIZED_KEY
                    ? t('uncategorized')
                    : (opt.group ?? '').trim()
                  nodes.push(
                    <div
                      key={`__group__${key}`}
                      className={styles.optionGroupHeader}
                      role="presentation"
                      aria-hidden
                    >
                      {headerLabel}
                    </div>,
                  )
                  lastGroupKey = key
                }
              }
              const selected = isSelected(opt.value)
              nodes.push(
                <button
                  key={opt.value}
                  type="button"
                  data-opt-idx={i}
                  disabled={opt.disabled}
                  className={clsx(
                    styles.option,
                    selected && styles.optionActive,
                    i === activeIdx && styles.optionHover,
                    opt.disabled && styles.optionDisabled,
                  )}
                  onClick={() => !opt.disabled && toggleValue(opt.value)}
                  onMouseEnter={() => setActiveIdx(i)}
                  role="option"
                  aria-selected={selected}
                >
                  <span className={styles.optionCheck}>{selected ? '✓' : ''}</span>
                  {opt.leading && (
                    <span className={clsx(styles.optionLeading, leadingClassName)} aria-hidden>
                      {opt.leading}
                    </span>
                  )}
                  <span className={styles.optionTextWrap}>
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {opt.sublabel && (
                      <span className={styles.optionSublabel}>{opt.sublabel}</span>
                    )}
                  </span>
                </button>,
              )
            })
            return nodes
          })()
        )}
      </div>
    </div>
  )

  return (
    <div className={clsx(styles.wrapper, className)}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(
          styles.trigger,
          open && styles.triggerOpen,
          disabled && styles.triggerDisabled,
          triggerClassName,
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
      >
        {triggerIcon && <span className={styles.triggerIcon}>{triggerIcon}</span>}
        {selectedOption?.leading && triggerLabel === undefined && (
          <span className={clsx(styles.triggerLeading, leadingClassName)} aria-hidden>
            {selectedOption.leading}
          </span>
        )}
        {showSelectedSublabel && !isMulti && triggerLabel === undefined && selectedOption?.sublabel && !label.isPlaceholder ? (
          <span className={styles.triggerTextWrap}>
            <span className={styles.triggerName}>{label.text}</span>
            <span className={styles.triggerSublabel}>{selectedOption.sublabel}</span>
          </span>
        ) : (
          <span
            className={clsx(
              styles.triggerLabel,
              label.isPlaceholder && styles.triggerPlaceholder,
            )}
          >
            {label.text}
          </span>
        )}
        <ChevronDown
          size={12}
          className={clsx(styles.chevron, open && styles.chevronOpen)}
        />
      </button>
      {open && (portal ? createPortal(popover, document.body) : popover)}
    </div>
  )
}
