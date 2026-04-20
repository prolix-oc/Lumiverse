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
import styles from './SearchableSelect.module.css'

export interface SearchableSelectOption {
  value: string
  label: string
  sublabel?: string
  /** Optional leading node (avatar, icon, swatch) rendered before the label in both the trigger and the option row. */
  leading?: ReactNode
  disabled?: boolean
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
  const {
    options,
    placeholder = 'Select…',
    searchPlaceholder = 'Search…',
    searchThreshold = 8,
    emptyMessage = 'No options available',
    noResultsMessage = 'No matches',
    disabled,
    className,
    triggerClassName,
    triggerIcon,
    triggerLabel,
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
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!needle) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        (o.sublabel && o.sublabel.toLowerCase().includes(needle)),
    )
  }, [options, needle])

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
        ;(props.onChange as (value: string) => void)(v)
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

  // Close on outside pointer-down
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const reposition = useCallback(() => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const width = Math.max(r.width, minWidth ?? 240)
    setPos({
      top: r.bottom + 4,
      left: align === 'right' ? r.right - width : r.left,
      width,
    })
  }, [align, minWidth])

  // Reposition rather than close on scroll/resize: focusing the search input
  // (mobile keyboard opens → viewport resize) or scrollIntoView inside the
  // option list would otherwise dismiss the popover the instant it opened.
  // Scrolls that originate inside the popover are ignored so the internal
  // option list can scroll freely.
  useEffect(() => {
    if (!open || !portal) return
    const handleScroll = (e: Event) => {
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      reposition()
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', handleScroll, true)
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
        maxHeight,
        ...(portal && pos
          ? { top: pos.top, left: pos.left, width: pos.width }
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
            <span className={styles.optionLabel}>{props.clearLabel ?? 'None'}</span>
          </button>
        )}
        {filtered.length === 0 ? (
          <div className={styles.emptyMessage}>
            {options.length === 0 ? emptyMessage : noResultsMessage}
          </div>
        ) : (
          filtered.map((opt, i) => {
            const selected = isSelected(opt.value)
            return (
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
                  <span className={styles.optionLeading} aria-hidden>
                    {opt.leading}
                  </span>
                )}
                <span className={styles.optionTextWrap}>
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.sublabel && (
                    <span className={styles.optionSublabel}>{opt.sublabel}</span>
                  )}
                </span>
              </button>
            )
          })
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
          <span className={styles.triggerLeading} aria-hidden>
            {selectedOption.leading}
          </span>
        )}
        <span
          className={clsx(
            styles.triggerLabel,
            label.isPlaceholder && styles.triggerPlaceholder,
          )}
        >
          {label.text}
        </span>
        <ChevronDown
          size={12}
          className={clsx(styles.chevron, open && styles.chevronOpen)}
        />
      </button>
      {open && (portal ? createPortal(popover, document.body) : popover)}
    </div>
  )
}
