import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { getUiScale } from '@/lib/uiScale'
import { ChevronDown, Search, X } from 'lucide-react'
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
/** Internal host signal shared with component bridges for body-portal ownership. */
export const PORTAL_OWNER_ACTIVE_ATTRIBUTE = 'data-spindle-component-portal-owner-active'
export const PORTAL_OWNER_ACTIVITY_EVENT = 'spindle:component-portal-owner-activity'


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
  /** Keep the search input visible even when the current result page is small. */
  forceSearch?: boolean
  /** Notify a server-backed picker when the search text changes. */
  onSearchChange?: (value: string) => void
  /** Options are already filtered by the server; skip the local text filter. */
  remoteSearch?: boolean
  /** Optional incremental-page state rendered inside the option list. */
  loading?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMessage?: string
  loadMoreLabel?: string
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
  /** Host-only ownership marker for extension-owned body portals. */
  portalOwnerId?: string
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
    forceSearch = false,
    onSearchChange,
    remoteSearch = false,
    loading = false,
    hasMore = false,
    onLoadMore,
    loadingMessage = t('loading', { defaultValue: 'Loading…' }),
    loadMoreLabel = t('loadMore', { defaultValue: 'Load more' }),
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
    portalOwnerId,
    align = 'left',
    maxHeight = 280,
    minWidth,
  } = props

  const isMulti = props.multi === true

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number | null; bottom: number | null; left: number; width: number; maxHeight: number } | null>(null)
  const listId = useId()

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => onSearchChange?.(search), [onSearchChange, search])
  const isPortalOwnerActive = useCallback(() => {
    if (!portal || !portalOwnerId) return true
    const popover = popoverRef.current
    return !popover || popover.getAttribute(PORTAL_OWNER_ACTIVE_ATTRIBUTE) !== 'false'
  }, [portal, portalOwnerId])


  const needle = search.trim().toLowerCase()
  const hasGroups = useMemo(
    () => options.some((o) => (o.group ?? '').trim().length > 0),
    [options],
  )
  const filtered = useMemo(() => {
    const base = !remoteSearch && needle
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
  }, [options, needle, hasGroups, remoteSearch])

  const isSelected = useCallback(
    (v: string) =>
      isMulti ? (props.value as string[]).includes(v) : props.value === v,
    [isMulti, props.value],
  )

  const hasClearOption = !isMulti && 'clearable' in props && props.clearable
  const clearOptionOffset = hasClearOption ? 1 : 0
  const clearOptionLabel = 'clearLabel' in props ? props.clearLabel ?? t('clear') : t('clear')
  const navigableOptions = useMemo<SearchableSelectOption[]>(() => hasClearOption
    ? [{ value: '', label: clearOptionLabel }, ...filtered]
    : filtered, [hasClearOption, filtered, clearOptionLabel])
  const firstEnabledIdx = navigableOptions.findIndex((option) => !option.disabled)
  const activeOptionIdx = navigableOptions[activeIdx] && !navigableOptions[activeIdx].disabled
    ? activeIdx : firstEnabledIdx
  const showSearch = forceSearch || options.length > searchThreshold || search.length > 0
  const pickerName = ariaLabel ?? placeholder

  const closePicker = useCallback((restoreFocus = false) => {
    setOpen(false)
    setSearch('')
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  const openPicker = () => {
    const selectedIdx = navigableOptions.findIndex((option) => !option.disabled && isSelected(option.value))
    setActiveIdx(selectedIdx >= 0 ? selectedIdx : firstEnabledIdx)
    setOpen(true)
  }

  const focusOption = (index: number) => {
    setActiveIdx(index)
    const option = listRef.current?.querySelector<HTMLElement>(`[data-opt-idx="${index}"]`)
    ;(option ?? listRef.current)?.focus()
  }

  const toggleValue = useCallback(
    (v: string) => {
      if (isMulti) {
        const cur = props.value as string[]
        const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
        ;(props.onChange as (value: string[]) => void)(next)
      } else {
        // Match native <select>: re-picking the selected option is not a change.
        if (v !== props.value) (props.onChange as (value: string) => void)(v)
        closePicker(true)
      }
    },
    [isMulti, props.onChange, props.value, closePicker],
  )

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
      if (!isPortalOwnerActive()) return
      if (!inTrigger && !inPopover) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('pointerdown', handle)
    return () => document.removeEventListener('pointerdown', handle)
  }, [open, isPortalOwnerActive])

  const reposition = useCallback(() => {
    if (!triggerRef.current) return
    // body carries `zoom: var(--lumiverse-ui-scale)` (see theme/reset.css), so
    // any portaled popover is rendered inside a zoomed layout context. getBoundingClientRect
    // returns post-zoom (rendered) coords, but the inline `top/left` we set are interpreted
    // in pre-zoom (layout) space — without compensating, the popover drifts off the trigger
    // and can slide partly off the viewport at scales >= 1.10.
    const uiScale = getUiScale()
    const r = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    const gap = 4
    // r.width is rendered; minWidth is specified in design units (pre-zoom).
    const layoutWidth = Math.min(
      Math.max(r.width / uiScale, minWidth ?? 240),
      Math.max(0, (vw - margin * 2) / uiScale),
    )
    const renderedWidth = layoutWidth * uiScale
    let renderedLeft = align === 'right' ? r.right - renderedWidth : r.left
    // Clamp horizontally so the popover stays on screen at any UI scale.
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
      if (!portal || !isPortalOwnerActive()) return
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      reposition()
    }
    const handleResize = () => {
      if (!isPortalOwnerActive()) return
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
  }, [open, portal, isPortalOwnerActive, reposition])

  useEffect(() => {
    if (!open || !portal || !portalOwnerId) return
    const popover = popoverRef.current
    if (!popover) return
    const handleOwnerActivity = () => {
      if (isPortalOwnerActive()) reposition()
    }
    popover.addEventListener(PORTAL_OWNER_ACTIVITY_EVENT, handleOwnerActivity)
    return () => popover.removeEventListener(PORTAL_OWNER_ACTIVITY_EVENT, handleOwnerActivity)
  }, [open, portal, portalOwnerId, isPortalOwnerActive, reposition])


  useLayoutEffect(() => {
    if (!open || !portal || !isPortalOwnerActive()) return
    reposition()
  }, [open, portal, isPortalOwnerActive, reposition])

  // Move real DOM focus into the popup, including lists without a search field.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const option = listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
      ;(searchRef.current ?? option ?? listRef.current)?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  // Search starts at the first matching enabled option, rather than the clear row.
  useEffect(() => {
    setActiveIdx(clearOptionOffset)
  }, [needle, clearOptionOffset])

  // Scroll active option into view
  useEffect(() => {
    if (!open) return
    const el = popoverRef.current?.querySelector(
      `[data-opt-idx="${activeOptionIdx}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionIdx, open, filtered])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      if (search) {
        e.preventDefault()
        e.stopPropagation()
        setSearch('')
        searchRef.current?.focus()
        return
      }
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        closePicker(true)
      }
      return
    }

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openPicker()
      }
      return
    }

    const target = e.target as HTMLElement
    const fromSearch = target === searchRef.current
    const fromTrigger = target === triggerRef.current
    const fromList = !!listRef.current?.contains(target)

    if (e.key === 'Tab') {
      const tabbable = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>(
        'input, button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]',
      ) ?? [])
      if (fromTrigger || (e.shiftKey ? target === tabbable[0] : target === tabbable.at(-1)) || target === listRef.current) {
        // Body portals must exit relative to their trigger, not the end of the page.
        closePicker(true)
        if (!fromTrigger) {
          // Browsers differ on whether Tab follows a focus change during keydown.
          // Choose the next control explicitly instead of relying on that default.
          e.preventDefault()
          if (!e.shiftKey) {
            const pageControls = Array.from(document.querySelectorAll<HTMLElement>(
              'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
            )).filter((control) => control.tabIndex >= 0
              && !control.matches(':disabled')
              && !control.closest('[inert], [hidden]')
              && !popoverRef.current?.contains(control)
              && control.getClientRects().length > 0)
            const triggerIdx = pageControls.indexOf(triggerRef.current!)
            if (triggerIdx >= 0) pageControls[triggerIdx + 1]?.focus()
          }
        }
      }
      return
    }

    if (!fromSearch && !fromTrigger && !fromList) return
    if (fromSearch && (e.altKey || e.ctrlKey || e.metaKey)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const direction = e.key === 'ArrowDown' ? 1 : -1
      let next = fromSearch || fromTrigger
        ? (direction === 1 ? -1 : navigableOptions.length)
        : activeOptionIdx
      do { next += direction } while (navigableOptions[next]?.disabled)
      if (next >= 0 && next < navigableOptions.length) focusOption(next)
    } else if (fromList && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      const index = e.key === 'Home' ? firstEnabledIdx : navigableOptions.findLastIndex((option) => !option.disabled)
      focusOption(index)
    } else if (fromSearch && e.key === 'Enter') {
      e.preventDefault()
      const opt = navigableOptions[activeOptionIdx]
      if (opt && !opt.disabled) {
        focusOption(activeOptionIdx)
        toggleValue(opt.value)
      }
    }
  }

  const selectedOption = useMemo(
    () => (isMulti ? undefined : options.find((o) => o.value === (props.value as string))),
    [isMulti, options, props.value],
  )

  const renderLabel = (): { text: string; isPlaceholder: boolean } => {
    if (triggerLabel !== undefined) return { text: triggerLabel, isPlaceholder: false }
    if (isMulti) {
      const count = (props.value as string[]).length
      return count === 0
        ? { text: placeholder, isPlaceholder: true }
        : { text: t('selectedCount', { count, defaultValue: '{{count}} selected' }), isPlaceholder: false }
    }
    return selectedOption
      ? { text: selectedOption.label, isPlaceholder: false }
      : { text: placeholder, isPlaceholder: true }
  }

  const label = renderLabel()

  const renderOption = (opt: SearchableSelectOption, index: number) => {
    const selected = isSelected(opt.value)
    return (
      <button
        key={opt.value}
        type="button"
        data-opt-idx={index}
        disabled={opt.disabled}
        tabIndex={index === activeOptionIdx ? 0 : -1}
        className={clsx(styles.option, selected && styles.optionActive, index === activeOptionIdx && styles.optionHover, opt.disabled && styles.optionDisabled)}
        onClick={() => !opt.disabled && toggleValue(opt.value)}
        onFocus={() => setActiveIdx(index)}
        role="option"
        aria-selected={selected}
        aria-disabled={opt.disabled || undefined}
      >
        <span className={styles.optionCheck} aria-hidden>{selected ? '✓' : ''}</span>
        {opt.leading && <span className={clsx(styles.optionLeading, leadingClassName)} aria-hidden>{opt.leading}</span>}
        <span className={styles.optionTextWrap}>
          <span className={styles.optionLabel}>{opt.label}</span>
          {opt.sublabel && <span className={styles.optionSublabel}>{opt.sublabel}</span>}
        </span>
      </button>
    )
  }

  const popover = (
    <div
      ref={popoverRef}
      className={clsx(styles.popover, portal && styles.popoverPortal)}
      data-spindle-component-portal={portal && portalOwnerId ? portalOwnerId : undefined}
      data-spindle-component-portal-owner-active={
        portal && portalOwnerId ? 'true' : undefined
      }
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && !popoverRef.current?.contains(next) && !triggerRef.current?.contains(next)) closePicker()
      }}
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
            placeholder={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={searchPlaceholder}
            aria-controls={listId}
          />
          {search && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => {
                setSearch('')
                setActiveIdx(0)
                searchRef.current?.focus()
              }}
              aria-label={t('clearSearch')}
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        className={styles.optionList}
        role="listbox"
        aria-label={pickerName}
        aria-multiselectable={isMulti || undefined}
        aria-busy={loading || undefined}
        tabIndex={-1}
      >
        {hasClearOption && renderOption(navigableOptions[0], 0)}
        {hasGroups ? (() => {
          const groups = new Map<string, ReactNode[]>()
          filtered.forEach((opt, index) => {
            const key = getGroupKey(opt)
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(renderOption(opt, index + clearOptionOffset))
          })
          return Array.from(groups, ([key, rows]) => {
            const name = key === UNCATEGORIZED_KEY ? t('uncategorized') : key
            return <div key={key} className={styles.optionGroup} role="group" aria-label={name}>
              <div className={styles.optionGroupHeader} aria-hidden>{name}</div>
              {rows}
            </div>
          })
        })() : filtered.map((opt, index) => renderOption(opt, index + clearOptionOffset))}
      </div>
      {filtered.length === 0 && (
        <div className={styles.emptyMessage} role="status">
          {loading ? loadingMessage : options.length === 0 ? emptyMessage : noResultsMessage}
        </div>
      )}
      {(hasMore || (loading && filtered.length > 0)) && onLoadMore && (
        <button
          type="button"
          className={styles.loadMore}
          onClick={onLoadMore}
          disabled={loading}
        >
          {loading ? loadingMessage : loadMoreLabel}
        </button>
      )}
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
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => { if (!disabled) { if (open) closePicker(); else openPicker() } }}
        onKeyDown={handleKeyDown}
      >
        {triggerIcon && <span className={styles.triggerIcon} aria-hidden>{triggerIcon}</span>}
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
          aria-hidden
          className={clsx(styles.chevron, open && styles.chevronOpen)}
        />
      </button>
      {open && (portal ? createPortal(popover, document.body) : popover)}
    </div>
  )
}
