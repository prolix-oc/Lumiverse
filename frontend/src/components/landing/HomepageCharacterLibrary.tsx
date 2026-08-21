import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { BookOpen, Edit3, MessageSquare, Pin, PinOff, Search, Settings, Star, X } from 'lucide-react'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { getTagColorVar } from '@/lib/tagColors'
import {
  fitHomepagePreviewImageSize,
  fitHomepagePreviewPaneWidth,
  getHomepagePreviewAvailableImageHeightWithGrowth,
  getHomepagePreviewStableFrameWidth,
  scaleHomepagePreviewImageWidth,
} from '@/lib/homepagePreviewImageFit'
import { layoutViewportSize } from '@/lib/uiScale'
import {
  getCharacterGridMetrics,
  getHomepageCardMetadata,
  getHomepageVisibleTags,
} from '@/lib/characterDisplaySettings'
import type { CharacterDisplaySettings } from '@/types/store'
import type { CharacterSummary } from '@/types/api'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import {
  clampHomepagePanelWidth,
  useHomepageCharacterLibrary,
  HOMEPAGE_PANEL_IMAGE_HEIGHT_DEFAULT,
  HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX,
  HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN,
} from '@/hooks/useHomepageCharacterLibrary'
import type { HomepageCharacterFilter } from '@/hooks/useHomepageCharacterLibrary'
import styles from './HomepageCharacterLibrary.module.css'

const FILTER_LABELS: Record<HomepageCharacterFilter, string> = {
  all: 'All',
  'this-chat': 'This Chat',
  favorites: 'Favorites',
  shared: 'Shared',
}

const FILTER_ORDER: readonly HomepageCharacterFilter[] = ['all', 'this-chat', 'favorites', 'shared']

const PROFILE_TAG_LIMIT = 8
const HOMEPAGE_PREVIEW_METADATA_MIN_CONTENT_WIDTH = 300
const HOMEPAGE_PREVIEW_DESKTOP_GUTTER = 48
const HOMEPAGE_PREVIEW_MOBILE_GUTTER = 24

/**
 * Tag colour arrives as a CSS custom property, never as a painted value. The stylesheet
 * composes the alpha (`rgba(var(--tag-rgb), 0.15)`), so a user override written against
 * `[data-component="HomepageCharacterLibrary"] .tag` still wins — an inline `background`
 * would have outranked it.
 */
function tagColorStyle(tag: string): CSSProperties {
  return { '--tag-rgb': getTagColorVar(tag) } as CSSProperties
}

function readPageBackground() {
  const root = window.getComputedStyle(document.documentElement)
  const rootRect = document.documentElement.getBoundingClientRect()
  const bodyBefore = window.getComputedStyle(document.body, '::before')
  const bodyAfter = window.getComputedStyle(document.body, '::after')
  const gridElement = document.querySelector<HTMLElement>('[data-landing-background-grid]')
  const grid = gridElement ? window.getComputedStyle(gridElement) : null
  const glows = [...document.querySelectorAll<HTMLElement>('[data-landing-background-glow]')].map((element) => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      image: style.backgroundImage,
      position: style.backgroundPosition,
      size: style.backgroundSize,
      repeat: style.backgroundRepeat,
      opacity: style.opacity,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
  })
  return {
    viewportWidth: rootRect.width,
    viewportHeight: rootRect.height,
    base: {
      color: root.backgroundColor,
      image: root.backgroundImage,
      position: root.backgroundPosition,
      size: root.backgroundSize,
      repeat: root.backgroundRepeat,
    },
    canvasLayers: [bodyBefore, bodyAfter].map((style) => ({
      image: style.backgroundImage,
      position: style.backgroundPosition,
      size: style.backgroundSize,
      repeat: style.backgroundRepeat,
      opacity: style.opacity,
      mixBlendMode: style.mixBlendMode as CSSProperties['mixBlendMode'],
    })),
    gridImage: grid?.backgroundImage ?? 'none',
    gridPosition: grid?.backgroundPosition ?? '0 0',
    gridSize: grid?.backgroundSize ?? 'auto',
    gridRepeat: grid?.backgroundRepeat ?? 'repeat',
    gridOpacity: grid?.display === 'none' ? '0' : (grid?.opacity ?? '0'),
    glows,
  }
}

interface LibraryCardProps {
  character: CharacterSummary
  selected: boolean
  footerMode: CharacterDisplaySettings['footerMode']
  showNameBackground: boolean
  showCreator: boolean
  showDescription: boolean
  showTags: boolean
  tagRows: number
  maxVisibleTags: number
  onSelect: (id: string) => void
  onOpen: (character: CharacterSummary) => void
}

/**
 * Memoised on primitives only. `display.visibleMetadata` is a fresh array on every settings
 * write, so it is flattened to `showCreator`/`showTags` before it reaches here — otherwise
 * every card would re-render whenever the panel is dragged or a selection is persisted.
 */
const LibraryCard = memo(function LibraryCard({
  character,
  selected,
  footerMode,
  showNameBackground,
  showCreator,
  showDescription,
  showTags,
  tagRows,
  maxVisibleTags,
  onSelect,
  onOpen,
}: LibraryCardProps) {
  const cardMetadata = getHomepageCardMetadata(character)
  const { visibleTags, hiddenTagCount } = getHomepageVisibleTags(
    cardMetadata.tags,
    maxVisibleTags,
    tagRows,
  )

  return (
    <button
      type="button"
      className={selected ? styles.cardSelected : styles.card}
      data-footer-mode={footerMode}
      data-name-background={showNameBackground}
      aria-label={`Preview ${character.name}`}
      aria-pressed={selected}
      onClick={() => onSelect(character.id)}
      onDoubleClick={() => onOpen(character)}
    >
      <span className={styles.imageFrame}>
        <img
          src={getCharacterAvatarLargeUrlById(character.id, character.image_id)}
          alt={character.name}
          loading="lazy"
        />
      </span>
      <span className={styles.cardFooter}>
        <span className={styles.cardName}>{character.name}</span>
        {showCreator && cardMetadata.creator && (
          <span className={styles.cardMeta}>{cardMetadata.creator}</span>
        )}
        {showDescription && character.preview_description && (
          <span className={styles.cardDescription}>{character.preview_description}</span>
        )}
        {tagRows > 0 && showTags && visibleTags.length > 0 && (
          <span className={styles.tags}>
            {visibleTags.map((tag) => (
              <span key={tag} className={styles.tag} style={tagColorStyle(tag)} title={tag}>
                {tag}
              </span>
            ))}
            {hiddenTagCount > 0 && <span className={styles.tagOverflow}>+{hiddenTagCount}</span>}
          </span>
        )}
      </span>
    </button>
  )
})

export function HomepageCharacterLibrary() {
  const openModal = useStore((state) => state.openModal)
  const {
    settings,
    display,
    characters,
    tags,
    selectedCharacter,
    preview,
    panelOpen,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    previewLoading,
    error,
    retry,
    filter,
    setFilter,
    search,
    setSearch,
    selectedTag,
    setSelectedTag,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    openSettings,
    activeChatId,
    selectCharacter,
    openingCharacterId,
    openCharacterChat,
    editCharacter,
    closePanel,
    setPanelPinned,
    setPanelWidth,
    setPanelImageHeight,
  } = useHomepageCharacterLibrary()
  const selectedCharacterId = selectedCharacter?.id ?? null

  // Live drag values. Writing straight to the store on every pointermove queued a debounced
  // server write and re-rendered the whole library ~90 times a second; the store now only
  // sees the committed value on pointer-up.
  const [livePanelWidth, setLivePanelWidth] = useState<number | null>(null)
  const [liveImageHeight, setLiveImageHeight] = useState<number | null>(null)
  const [autoImageSize, setAutoImageSize] = useState<{
    width: number
    height: number
    aspectRatio: number
    stableWidth: number
  } | null>(null)
  const [previewChromeWidth, setPreviewChromeWidth] = useState(0)
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  )
  const [pageBackground, setPageBackground] = useState(readPageBackground)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)')
    const updateViewport = () => setIsMobileViewport(query.matches)
    query.addEventListener('change', updateViewport)
    return () => query.removeEventListener('change', updateViewport)
  }, [])

  // Infinite scroll. The sentinel is only mounted while there is another page to ask for,
  // so unmounting it is itself the "stop" signal — the observer below tears down with it.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLElement>(null)
  const previewBodyRef = useRef<HTMLDivElement>(null)
  const previewImageFrameRef = useRef<HTMLDivElement>(null)
  const previewImageRef = useRef<HTMLImageElement>(null)
  const previewMetadataRef = useRef<HTMLDivElement>(null)
  const closePreviewButtonRef = useRef<HTMLButtonElement>(null)
  const previewReturnFocusRef = useRef<HTMLElement | null>(null)
  const wasMobilePreviewOpenRef = useRef(false)
  const [previewOrigin, setPreviewOrigin] = useState({ left: 0, top: 0, ready: false })
  const showSentinel = hasMore && characters.length > 0
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || loading) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      // Deep enough to start the next request before the user reaches the last row, so the
      // grid grows without a visible stall.
      { rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // `characters.length` re-arms the observer after each append. Without it a page that
    // lands while the sentinel is still inside the root margin produces no new
    // intersection entry, and paging stalls until the user scrolls away and back.
  }, [characters.length, loadMore, loading, showSentinel])

  const handleSelectCharacter = useCallback((id: string) => {
    if (isMobileViewport && document.activeElement instanceof HTMLElement) {
      previewReturnFocusRef.current = document.activeElement
      setPageBackground(readPageBackground())
    }
    selectCharacter(id)
  }, [isMobileViewport, selectCharacter])

  useEffect(() => {
    const mobilePreviewOpen = Boolean(
      panelOpen
      && selectedCharacterId
      && isMobileViewport,
    )

    if (mobilePreviewOpen) {
      wasMobilePreviewOpenRef.current = true
      const frame = window.requestAnimationFrame(() => closePreviewButtonRef.current?.focus())
      return () => window.cancelAnimationFrame(frame)
    }

    if (wasMobilePreviewOpenRef.current) {
      wasMobilePreviewOpenRef.current = false
      previewReturnFocusRef.current?.focus()
      previewReturnFocusRef.current = null
    }
  }, [isMobileViewport, panelOpen, selectedCharacterId])

  useLayoutEffect(() => {
    if (!isMobileViewport || !panelOpen || !previewRef.current) return
    const preview = previewRef.current
    const updateOrigin = () => {
      const rect = preview.getBoundingClientRect()
      setPreviewOrigin({ left: rect.left, top: rect.top, ready: true })
    }
    updateOrigin()
    const observer = new ResizeObserver(updateOrigin)
    observer.observe(preview)
    window.addEventListener('resize', updateOrigin)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateOrigin)
    }
  }, [isMobileViewport, panelOpen])

  const handlePreviewKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (isMobileViewport && event.key === 'Escape') {
      event.preventDefault()
      closePanel()
      return
    }

    if (event.key !== 'Tab' || !isMobileViewport) return

    const focusable = previewRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )
    if (!focusable?.length) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [closePanel, isMobileViewport])

  const panelWidth = livePanelWidth ?? settings.panelWidth
  const preferredImageHeight = settings.panelImageHeight ?? HOMEPAGE_PANEL_IMAGE_HEIGHT_DEFAULT
  const requestedImageHeight = liveImageHeight ?? preferredImageHeight
  const panelImageHeight = autoImageSize?.height ?? requestedImageHeight
  const panelImageWidth = autoImageSize
    ? scaleHomepagePreviewImageWidth(panelImageHeight, autoImageSize.aspectRatio, autoImageSize.width)
    : null
  const previewAutoWidth = fitHomepagePreviewPaneWidth({
    imageWidth: autoImageSize?.stableWidth ?? null,
    metadataMinWidth: HOMEPAGE_PREVIEW_METADATA_MIN_CONTENT_WIDTH,
    chromeWidth: previewChromeWidth,
    manualMaxWidth: panelWidth,
  })

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = settings.panelWidth
    let latest = startWidth
    let frame = 0
    const onMove = (moveEvent: PointerEvent) => {
      latest = clampHomepagePanelWidth(startWidth + startX - moveEvent.clientX)
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        setLivePanelWidth(latest)
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      if (frame) window.cancelAnimationFrame(frame)
      setLivePanelWidth(null)
      setPanelWidth(latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [settings.panelWidth, setPanelWidth])

  const commitImageHeight = useCallback((requestedHeight = liveImageHeight) => {
    if (requestedHeight === null) return
    const committedHeight = Math.min(
      HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX,
      Math.max(HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN, requestedHeight),
    )
    setPanelImageHeight(committedHeight)
    setLiveImageHeight(null)
  }, [liveImageHeight, setPanelImageHeight])

  // ~900 <option> nodes. Rebuilding them on every render was the dominant cost in the
  // component; a stable element array lets React bail out of the whole subtree.
  const tagOptions = useMemo(
    () => tags.map(({ tag, count }) => <option key={tag} value={tag}>{tag} ({count})</option>),
    [tags],
  )

  const gridMetrics = getCharacterGridMetrics(display)
  const maxVisibleTags = settings.maxVisibleTags ?? 6
  const showNameBackground = settings.showNameBackground ?? false
  const showCreator = display.visibleMetadata.includes('creator')
  const showDescription = display.visibleMetadata.includes('description')
  const showTags = display.visibleMetadata.includes('tags')
  const showLorebooks = display.visibleMetadata.includes('lorebooks')
  const showLastChat = display.visibleMetadata.includes('lastChat')
  const tagRowsMaxHeight = display.tagRows > 0
    ? display.tagRows * 20 + Math.max(display.tagRows - 1, 0) * 4
    : 0
  const descriptionMaxHeight = showDescription ? 36 : 0
  const compactFooterMaxHeight = 44 + descriptionMaxHeight + tagRowsMaxHeight
  const selectedAvatarUrl = selectedCharacter
    ? getCharacterAvatarLargeUrlById(selectedCharacter.id, selectedCharacter.image_id)
    : ''
  const selectedTagSummary = selectedCharacter
    ? getHomepageVisibleTags(selectedCharacter.tags, PROFILE_TAG_LIMIT, 1)
    : { visibleTags: [], hiddenTagCount: 0 }
  const selectedDescription = preview?.character.preview_description || selectedCharacter?.preview_description || ''
  const showPreviewTags = Boolean(
    showTags && (
      selectedCharacter?.has_alternate_greetings
        || selectedTagSummary.visibleTags.length > 0
        || selectedTagSummary.hiddenTagCount > 0
    ),
  )

  const fitPreviewImage = useCallback(() => {
    const body = previewBodyRef.current
    const frame = previewImageFrameRef.current
    const image = previewImageRef.current
    const metadata = previewMetadataRef.current
    const previewElement = previewRef.current
    if (!body || !frame || !image || !metadata || !previewElement || !image.complete) return

    const constrained = isMobileViewport || settings.panelPinned
    const previewStyle = window.getComputedStyle(previewElement)
    const chromeWidth = [
      previewStyle.paddingLeft,
      previewStyle.paddingRight,
      previewStyle.borderLeftWidth,
      previewStyle.borderRightWidth,
    ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0)
    const viewportWidth = layoutViewportSize().width
    const gutter = isMobileViewport ? HOMEPAGE_PREVIEW_MOBILE_GUTTER : HOMEPAGE_PREVIEW_DESKTOP_GUTTER
    const stableFrameWidth = getHomepagePreviewStableFrameWidth({
      panelMaxWidth: panelWidth,
      layoutViewportWidth: viewportWidth,
      gutter,
      chromeWidth,
    })
    const rowGap = Number.parseFloat(window.getComputedStyle(body).rowGap) || 0
    const maximumPreviewHeight = Number.parseFloat(previewStyle.maxHeight)
    const bodyHeight = body.getBoundingClientRect().height
    const metadataHeight = metadata.getBoundingClientRect().height
    const previewHeight = previewElement.getBoundingClientRect().height
    const availableHeight = constrained
      ? getHomepagePreviewAvailableImageHeightWithGrowth(
          bodyHeight,
          metadataHeight,
          rowGap,
          previewHeight,
          maximumPreviewHeight,
        )
      : undefined
    const nextSize = fitHomepagePreviewImageSize({
      frameWidth: constrained ? stableFrameWidth : (body.clientWidth || frame.clientWidth),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      availableHeight,
      preferredMaxHeight: requestedImageHeight,
      absoluteMaxHeight: HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX,
    })
    if (nextSize === null) return
    setPreviewChromeWidth((current) => current === chromeWidth ? current : chromeWidth)
    setAutoImageSize((current) => (
      current?.width === nextSize.width
        && current.height === nextSize.height
        && current.aspectRatio === nextSize.aspectRatio
        && current.stableWidth === nextSize.stableWidth
        ? current
        : nextSize
    ))
  }, [isMobileViewport, panelWidth, requestedImageHeight, settings.panelPinned])

  useLayoutEffect(() => {
    setAutoImageSize(null)
  }, [selectedAvatarUrl])

  useLayoutEffect(() => {
    if (!panelOpen || !selectedCharacter) return
    let frame = 0
    const scheduleFit = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        fitPreviewImage()
      })
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleFit)
    if (previewBodyRef.current) observer?.observe(previewBodyRef.current)
    if (previewMetadataRef.current) observer?.observe(previewMetadataRef.current)
    window.addEventListener('resize', scheduleFit)
    scheduleFit()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleFit)
    }
  }, [
    fitPreviewImage,
    panelOpen,
    preview,
    selectedAvatarUrl,
    selectedCharacter,
    showCreator,
    showDescription,
    showLastChat,
    showLorebooks,
    showPreviewTags,
  ])

  const cards = useMemo(() => characters.map((character) => (
    <LibraryCard
      key={character.id}
      character={character}
      selected={selectedCharacterId === character.id}
      footerMode={display.footerMode}
      showNameBackground={showNameBackground}
      showCreator={showCreator}
      showDescription={showDescription}
      showTags={showTags}
      tagRows={display.tagRows}
      maxVisibleTags={maxVisibleTags}
      onSelect={handleSelectCharacter}
      onOpen={openCharacterChat}
    />
  )), [
    characters,
    display.footerMode,
    display.tagRows,
    maxVisibleTags,
    openCharacterChat,
    handleSelectCharacter,
    selectedCharacterId,
    showCreator,
    showDescription,
    showNameBackground,
    showTags,
  ])

  if (!settings.enabled) return null

  return (
    <section
      className={styles.library}
      data-component="HomepageCharacterLibrary"
      aria-label="Character library"
    >
      <div className={styles.header}>
        <div>
          <h2>Character Library</h2>
          <p>Browse, preview, and open characters without entering management.</p>
        </div>
        <label className={styles.searchField}>
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search names, tags, creators..."
            aria-label="Search characters"
            className={styles.search}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          icon={<Settings size={15} />}
          className={styles.settingsBtn}
          onClick={openSettings}
          title="Homepage character library settings"
        >
          Settings
        </Button>
      </div>

      <div className={styles.controls}>
        <div className={styles.filters} role="group" aria-label="Character filter">
          {FILTER_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              className={filter === item ? styles.filterActive : styles.filter}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {FILTER_LABELS[item]}
            </button>
          ))}
        </div>
        <select
          value={selectedTag}
          onChange={(event) => setSelectedTag(event.target.value)}
          aria-label="Filter by tag"
          className={styles.select}
        >
          <option value="">All tags</option>
          {tagOptions}
        </select>
        <select
          value={sortField}
          onChange={(event) => setSortField(event.target.value as typeof sortField)}
          aria-label="Sort characters by"
          className={styles.select}
        >
          <option value="recent">Recently used</option>
          <option value="most_chats">Most chats</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
          <option value="shuffle">Discover</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
          disabled={sortField === 'shuffle'}
        >
          {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
        </Button>
      </div>

      {error && (
        <div className={styles.state} data-state="error" role="alert">
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={retry}>Retry</Button>
        </div>
      )}
      {loading && characters.length === 0 && <div className={styles.state} data-state="loading" role="status">Loading characters...</div>}
      {!loading && !error && filter === 'this-chat' && !activeChatId && (
        <div className={styles.state} data-state="empty">No active chat is selected.</div>
      )}

      <div
        className={styles.body}
        data-panel-open={panelOpen && !!selectedCharacter}
        style={{
          '--homepage-panel-width': `${panelWidth}px`,
          '--homepage-panel-image-height': `${panelImageHeight}px`,
          '--homepage-preview-layout-width': `${settings.panelPinned ? previewAutoWidth : panelWidth}px`,
        } as CSSProperties}
      >
        <div
          className={styles.grid}
          data-view-mode={display.viewMode}
          style={{
            '--character-card-width': `${display.thumbnailWidth}px`,
            '--character-image-height': `${display.thumbnailHeight}px`,
            '--character-tags-max-height': `${tagRowsMaxHeight}px`,
            '--character-footer-max-height': `${compactFooterMaxHeight}px`,
            '--character-grid-gap': `${gridMetrics.gap}px`,
          } as CSSProperties}
        >
          {!loading && !error && characters.length === 0 && !(filter === 'this-chat' && !activeChatId) && (
            <div className={styles.state} data-state="empty">No characters match the current library filters.</div>
          )}
          {cards}
          {!loading && activeChatId && filter === 'this-chat' && characters.length === 0 && (
            <div className={styles.state} data-state="empty">The active chat has no available characters.</div>
          )}
          {loadingMore && <div className={styles.loadingMore}>Loading more characters...</div>}
          {showSentinel && <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />}
        </div>

        {panelOpen && selectedCharacter && (
          <aside
            ref={previewRef}
            className={styles.preview}
            data-pinned={settings.panelPinned}
            style={{
              '--homepage-preview-grid-image': pageBackground.gridImage,
              '--homepage-preview-grid-position': pageBackground.gridPosition,
              '--homepage-preview-grid-size': pageBackground.gridSize,
              '--homepage-preview-grid-repeat': pageBackground.gridRepeat,
              '--homepage-preview-grid-opacity': pageBackground.gridOpacity,
              '--homepage-preview-auto-width': `${previewAutoWidth}px`,
            } as CSSProperties}
            role={isMobileViewport ? 'dialog' : undefined}
            aria-modal={isMobileViewport || undefined}
            aria-labelledby={isMobileViewport ? 'homepage-character-preview-title' : undefined}
            onKeyDown={handlePreviewKeyDown}
          >
            {isMobileViewport && previewOrigin.ready && (
              <div className={styles.previewBackdrop} aria-hidden="true">
                <span
                  className={styles.previewBackdropViewportLayer}
                  style={{
                    left: -previewOrigin.left,
                    top: -previewOrigin.top,
                    width: pageBackground.viewportWidth,
                    height: pageBackground.viewportHeight,
                    backgroundColor: pageBackground.base.color,
                    backgroundImage: pageBackground.base.image,
                    backgroundPosition: pageBackground.base.position,
                    backgroundSize: pageBackground.base.size,
                    backgroundRepeat: pageBackground.base.repeat,
                  }}
                />
                {pageBackground.canvasLayers.map((layer, index) => (
                  <span
                    key={`canvas-${index}`}
                    className={styles.previewBackdropViewportLayer}
                    style={{
                      left: -previewOrigin.left,
                      top: -previewOrigin.top,
                      width: pageBackground.viewportWidth,
                      height: pageBackground.viewportHeight,
                      backgroundImage: layer.image,
                      backgroundPosition: layer.position,
                      backgroundSize: layer.size,
                      backgroundRepeat: layer.repeat,
                      opacity: layer.opacity,
                      mixBlendMode: layer.mixBlendMode,
                    }}
                  />
                ))}
                {pageBackground.glows.map((glow, index) => (
                  <span
                    key={index}
                    className={styles.previewBackdropGlow}
                    style={{
                      left: glow.left - previewOrigin.left,
                      top: glow.top - previewOrigin.top,
                      width: glow.width,
                      height: glow.height,
                      backgroundImage: glow.image,
                      backgroundPosition: glow.position,
                      backgroundSize: glow.size,
                      backgroundRepeat: glow.repeat,
                      opacity: glow.opacity,
                    }}
                  />
                ))}
              </div>
            )}
            <div className={styles.resizeHandle} onPointerDown={beginResize} aria-hidden="true" />
            <div className={styles.previewControls}>
              <button
                type="button"
                aria-label={settings.panelPinned ? 'Unpin preview' : 'Pin preview'}
                title={settings.panelPinned ? 'Unpin preview' : 'Pin preview'}
                onClick={() => setPanelPinned(!settings.panelPinned)}
              >
                {settings.panelPinned ? <Pin size={15} /> : <PinOff size={15} />}
              </button>
              <button ref={closePreviewButtonRef} type="button" aria-label="Close preview" title="Close preview" onClick={closePanel}><X size={16} /></button>
            </div>
            <div ref={previewBodyRef} className={styles.previewBody}>
              <div
                ref={previewImageFrameRef}
                className={styles.previewImageFrame}
                style={{
                  '--preview-image-url': `url("${selectedAvatarUrl}")`,
                  '--homepage-preview-image-width': panelImageWidth ? `${panelImageWidth}px` : '100%',
                } as CSSProperties}
              >
                <img
                  ref={previewImageRef}
                  src={selectedAvatarUrl}
                  alt={selectedCharacter.name}
                  onLoad={fitPreviewImage}
                />
              </div>
              <div ref={previewMetadataRef} className={styles.previewMetadata}>
                <label className={styles.imageHeightControl}>
                  <span>Image H</span>
                  <input
                    type="range"
                    min={HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN}
                    max={HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX}
                    value={requestedImageHeight}
                    onChange={(event) => setLiveImageHeight(Math.min(
                      HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX,
                      Math.max(HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN, Number(event.target.value)),
                    ))}
                    onPointerUp={(event) => commitImageHeight(Number(event.currentTarget.value))}
                    onKeyUp={(event) => commitImageHeight(Number(event.currentTarget.value))}
                    onBlur={(event) => commitImageHeight(Number(event.currentTarget.value))}
                  />
                  <span>{requestedImageHeight}px</span>
                </label>
                <div className={styles.previewHeader}>
                  <div>
                    <h3 id="homepage-character-preview-title">{selectedCharacter.name}</h3>
                    {showCreator && selectedCharacter.creator && <p>{selectedCharacter.creator}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Edit3 size={14} />}
                    className={styles.editBtn}
                    title="Edit character"
                    onClick={() => editCharacter(selectedCharacter.id)}
                  >
                    Edit
                  </Button>
                </div>
                {showDescription && selectedDescription && (
                  <p className={styles.previewDescription}>{selectedDescription}</p>
                )}
                {showPreviewTags && (
                  <div className={styles.previewTags}>
                    {selectedCharacter.has_alternate_greetings && <span><Star size={12} /> Alt greetings</span>}
                    {showTags && selectedTagSummary.visibleTags.map((tag) => (
                      <span key={tag} className={styles.previewTag} style={tagColorStyle(tag)}>{tag}</span>
                    ))}
                    {showTags && selectedTagSummary.hiddenTagCount > 0 && <span>+{selectedTagSummary.hiddenTagCount}</span>}
                  </div>
                )}
                {previewLoading && (showLorebooks || showLastChat) && <div className={styles.state}>Loading preview...</div>}
                {!previewLoading && preview && (
                  <>
                    {showLorebooks && (
                      <div className={styles.previewSection}>
                        <h4><BookOpen size={14} /> Lorebooks</h4>
                        {preview.lorebooks.length > 0
                          ? <div className={styles.lorebooks}>{preview.lorebooks.map((book) => (
                            <button key={book.id} type="button" onClick={() => openModal('worldBookEditor', { bookId: book.id })}>
                              {book.name}
                            </button>
                          ))}</div>
                          : <p>No attached lorebooks</p>}
                      </div>
                    )}
                    {showLastChat && (
                      <div className={styles.previewSection}>
                        <h4><MessageSquare size={14} /> Last chat</h4>
                        {preview.last_chat
                          ? <div className={styles.lastChat}><strong>{preview.last_chat.name || selectedCharacter.name}</strong><p>{preview.last_chat.last_message_preview || 'No messages yet'}</p></div>
                          : <p>No existing chat</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <Button
              variant="primary"
              icon={<MessageSquare size={15} />}
              className={styles.openChatBtn}
              disabled={previewLoading || openingCharacterId === selectedCharacter.id}
              onClick={() => openCharacterChat(selectedCharacter)}
            >
              {preview?.open_chat_id ? 'Open in chat' : 'Start chat'}
            </Button>
          </aside>
        )}
      </div>
    </section>
  )
}
