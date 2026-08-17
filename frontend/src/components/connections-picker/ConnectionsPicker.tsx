import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Star,
  X,
} from 'lucide-react'
import { get } from '@/api/client'
import { connectionsApi } from '@/api/connections'
import { ResizablePanelFrame } from '@/components/shared/ResizablePanelFrame'
import {
  CONNECTIONS_PICKER_RECTS_STORAGE_KEY,
  filterConnectionProfiles,
  getBalancedModelGridColumns,
  getConnectionProfileFavoriteModels,
  getProviderTagsPickerHeight,
  normalizeConnectionProfileTags,
  parseConnectionsPickerVariantRects,
  resolveAnchoredConnectionsPickerRect,
  resolveConnectionsPickerRect,
  setConnectionProfileFavoriteModels,
} from '@/lib/connectionsPicker'
import { DEFAULT_CONNECTIONS_PICKER_SETTINGS } from '@/lib/uiProductivityDefaults'
import { useSpindleComponentOverride } from '@/lib/spindle/use-spindle-component-override'
import { useStore } from '@/store'
import type { ConnectionModelsResult, ConnectionProfile } from '@/types/api'
import type { ConnectionsPickerVariant, SurfaceRectPrefs } from '@/types/store'
import styles from './ConnectionsPicker.module.css'

interface ConnectionsPickerProps {
  open: boolean
  onClose: () => void
  anchorElement?: HTMLElement | null
}

export function filterModelsForQuery(
  models: readonly string[],
  labels: Record<string, string>,
  query: string,
): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...models]
  return models.filter((model) => {
    const label = (labels[model] || model).toLowerCase()
    return model.toLowerCase().includes(needle) || label.includes(needle)
  })
}

export function shouldApplyModelsResponse(options: {
  requestId: number
  currentRequestId: number
  requestedProfileId: string
  selectedProfileId: string | null
  profiles: ReadonlyArray<{ id: string }>
}): boolean {
  if (options.requestId !== options.currentRequestId) return false
  if (options.selectedProfileId !== options.requestedProfileId) return false
  return options.profiles.some((profile) => profile.id === options.requestedProfileId)
}

const DENSITY_CLASS = {
  compact: styles.densityCompact,
  balanced: styles.densityBalanced,
  spacious: styles.densitySpacious,
  custom: styles.densityBalanced,
} as const

const VARIANTS: Array<{ id: ConnectionsPickerVariant; label: string }> = [
  { id: 'provider-tags', label: 'A' },
  { id: 'split', label: 'B' },
  { id: 'full', label: 'C' },
]

const MIN_COLUMN_WIDTH = 180

/** The custom property each resizable column publishes its width through. */
const COLUMN_WIDTH_VAR = {
  profiles: '--connections-profile-width',
  models: '--connections-model-width',
} as const

type ProviderTab = 'favorites' | 'recent' | 'all' | `tag:${string}`

const PICKER_BOUNDS = {
  'provider-tags': { minWidth: 360, minHeight: 220, maxHeight: 380 },
  split: { minWidth: 680, minHeight: 480 },
  full: { minWidth: 820, minHeight: 520 },
} as const

function metadataChanged(
  profile: ConnectionProfile,
  previous: ConnectionProfile | undefined,
): boolean {
  return JSON.stringify(profile.metadata) !== JSON.stringify(previous?.metadata)
}

function clampColumnWidth(
  width: number,
  key: 'profiles' | 'models',
  variant: ConnectionsPickerVariant,
  frameWidth: number,
): number {
  const reservedWidth = variant === 'split'
    ? 320
    : key === 'profiles'
      ? 430
      : 440
  const maxWidth = Math.max(MIN_COLUMN_WIDTH, frameWidth - reservedWidth)
  return Math.min(maxWidth, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
}

function loadVariantRects() {
  if (typeof window === 'undefined') return {}
  try {
    return parseConnectionsPickerVariantRects(
      window.localStorage.getItem(CONNECTIONS_PICKER_RECTS_STORAGE_KEY),
    )
  } catch {
    return {}
  }
}

function ConnectionsPickerNative({ open, onClose, anchorElement }: ConnectionsPickerProps) {
  const storedSettings = useStore((s) => s.connectionsPickerSettings)
  const settings = useMemo(() => ({
    ...DEFAULT_CONNECTIONS_PICKER_SETTINGS,
    modelLayout: 'grid' as const,
    ...storedSettings,
  }), [storedSettings])
  const modelLayout = settings.modelLayout === 'list' ? 'list' : 'grid'
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const setActiveProfile = useStore((s) => s.setActiveProfile)
  const updateProfile = useStore((s) => s.updateProfile)
  const setProfiles = useStore((s) => s.setProfiles)
  const setSetting = useStore((s) => s.setSetting)
  const openDrawer = useStore((s) => s.openDrawer)
  const [query, setQuery] = useState('')
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(activeProfileId)
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelGridColumns, setModelGridColumns] = useState(2)
  const [providerTab, setProviderTab] = useState<ProviderTab>('favorites')
  const [providerSearchOpen, setProviderSearchOpen] = useState(false)
  const modelGridRef = useRef<HTMLDivElement>(null)
  const cardRailRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const initialVariantRef = useRef(settings.variant)
  const variantRectsRef = useRef(loadVariantRects())
  const currentFrameRectRef = useRef(settings.rect)
  const selectedProfileIdRef = useRef(selectedProfileId)
  const modelsRequestRef = useRef(0)
  selectedProfileIdRef.current = selectedProfileId

  const updateSettings = useCallback((patch: Partial<typeof settings>) => {
    setSetting('connectionsPickerSettings', { ...settings, ...patch })
  }, [setSetting, settings])

  const loadModels = useCallback(async (profileId: string, cacheBust = false) => {
    const requestId = ++modelsRequestRef.current
    setModelsLoading(true)
    try {
      const result = cacheBust
        ? await get<ConnectionModelsResult>(`/connections/${profileId}/models`, { _ts: Date.now() })
        : await connectionsApi.models(profileId)
      if (!shouldApplyModelsResponse({
        requestId,
        currentRequestId: modelsRequestRef.current,
        requestedProfileId: profileId,
        selectedProfileId: selectedProfileIdRef.current,
        profiles: useStore.getState().profiles,
      })) return
      setModels(result.models)
      setModelLabels(result.model_labels ?? {})
    } catch {
      if (!shouldApplyModelsResponse({
        requestId,
        currentRequestId: modelsRequestRef.current,
        requestedProfileId: profileId,
        selectedProfileId: selectedProfileIdRef.current,
        profiles: useStore.getState().profiles,
      })) return
      const fallback = useStore.getState().profiles.find((profile) => profile.id === profileId)
      setModels(fallback?.model ? [fallback.model] : [])
      setModelLabels({})
    } finally {
      if (requestId === modelsRequestRef.current) setModelsLoading(false)
    }
  }, [])

  const rememberVariantRect = useCallback((variant: ConnectionsPickerVariant, rect: SurfaceRectPrefs) => {
    const nextRects = { ...variantRectsRef.current, [variant]: rect }
    variantRectsRef.current = nextRects
    try {
      window.localStorage.setItem(CONNECTIONS_PICKER_RECTS_STORAGE_KEY, JSON.stringify(nextRects))
    } catch {
      // Store persistence can be unavailable in restricted browser contexts.
    }
  }, [])

  useEffect(() => {
    const normalized = normalizeConnectionProfileTags(profiles, settings.profileTags)
    const tagsChanged = JSON.stringify(normalized.profileTags) !== JSON.stringify(settings.profileTags)
    const profilesChanged = normalized.profiles.some((profile, index) => (
      metadataChanged(profile, profiles[index])
    ))
    if (tagsChanged) {
      updateSettings({
        profileTags: normalized.profileTags,
        visibleTagIds: settings.visibleTagIds.length > 0
          ? settings.visibleTagIds.filter((id) => normalized.profileTags.some((tag) => tag.id === id))
          : normalized.profileTags.map((tag) => tag.id),
      })
    }
    if (profilesChanged) {
      setProfiles(normalized.profiles)
      normalized.profiles.forEach((profile, index) => {
        if (metadataChanged(profile, profiles[index])) {
          void connectionsApi.update(profile.id, { metadata: profile.metadata })
        }
      })
    }
  }, [profiles, setProfiles, settings.profileTags, settings.visibleTagIds, updateSettings])

  useEffect(() => {
    if (!open) return
    if (settings.variant === 'provider-tags' && anchorElement) return
    setSelectedProfileId(activeProfileId ?? profiles[0]?.id ?? null)
  }, [activeProfileId, anchorElement, open, profiles, settings.variant])

  useEffect(() => {
    if (!selectedProfileId) return
    if (profiles.some((profile) => profile.id === selectedProfileId)) return
    modelsRequestRef.current += 1
    const fallbackId = activeProfileId && profiles.some((profile) => profile.id === activeProfileId)
      ? activeProfileId
      : profiles[0]?.id ?? null
    setSelectedProfileId(fallbackId)
  }, [activeProfileId, profiles, selectedProfileId])

  useEffect(() => {
    if (!open) return
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0)
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0)
    const bounds = PICKER_BOUNDS[settings.variant]
    const rememberedRect = variantRectsRef.current[settings.variant]
    const canMigrateSharedRect = (
      settings.variant === initialVariantRef.current
      && settings.positionInitialized
    )
    const rect = resolveConnectionsPickerRect(
      rememberedRect
        ?? (canMigrateSharedRect ? settings.rect : DEFAULT_CONNECTIONS_PICKER_SETTINGS.rect),
      bounds,
      viewportWidth,
      viewportHeight,
      !rememberedRect && !canMigrateSharedRect,
    )
    rememberVariantRect(settings.variant, rect)
    if (
      settings.positionInitialized
      && rect.x === settings.rect.x
      && rect.y === settings.rect.y
      && rect.width === settings.rect.width
      && rect.height === settings.rect.height
    ) return
    updateSettings({ rect, positionInitialized: true })
  }, [anchorElement, open, rememberVariantRect, settings.positionInitialized, settings.rect, settings.variant, updateSettings])

  const visibleTags = useMemo(() => {
    const visibleIds = settings.visibleTagIds.length > 0
      ? new Set(settings.visibleTagIds)
      : new Set(settings.profileTags.map((tag) => tag.id))
    return [...settings.profileTags]
      .filter((tag) => visibleIds.has(tag.id))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }, [settings.profileTags, settings.visibleTagIds])

  const filteredProfiles = useMemo(
    () => filterConnectionProfiles(profiles, settings.profileTags, query, selectedTagId),
    [profiles, query, selectedTagId, settings.profileTags],
  )
  const favoriteProfiles = filteredProfiles.filter((profile) => settings.favoriteProfileIds.includes(profile.id))
  const recentProfiles = settings.recentProfileIds
    .map((id) => filteredProfiles.find((profile) => profile.id === id))
    .filter((profile): profile is ConnectionProfile => Boolean(profile))
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null
  const favoriteModels = selectedProfile ? getConnectionProfileFavoriteModels(selectedProfile) : []
  const favoriteModelSet = new Set(favoriteModels)
  const orderedModels = [...models].sort((a, b) => Number(favoriteModelSet.has(b)) - Number(favoriteModelSet.has(a)))
  const visibleModels = filterModelsForQuery(orderedModels, modelLabels, query)
  const savedProfiles = filteredProfiles.filter((profile) => profile.id !== selectedProfile?.id)
  const variantAProfiles = providerTab === 'favorites'
    ? favoriteProfiles
    : providerTab === 'recent'
      ? recentProfiles
      : filteredProfiles
  const providerTabShowsModels = providerTab.startsWith('tag:')

  useEffect(() => {
    if (providerTab === 'all') return
    if (providerTab === 'favorites' && favoriteProfiles.length > 0) return
    if (providerTab === 'recent' && recentProfiles.length > 0) return
    if (providerTab.startsWith('tag:') && visibleTags.some((tag) => providerTab === `tag:${tag.id}`)) return
    setProviderTab(settings.showFavorites && favoriteProfiles.length > 0 ? 'favorites' : 'all')
  }, [favoriteProfiles.length, providerTab, recentProfiles.length, settings.showFavorites, visibleTags])

  useEffect(() => {
    if (!open || !providerTabShowsModels || variantAProfiles.length === 0) return
    if (selectedProfileId && variantAProfiles.some((profile) => profile.id === selectedProfileId)) return
    setSelectedProfileId(variantAProfiles[0].id)
  }, [open, providerTabShowsModels, selectedProfileId, variantAProfiles])

  useEffect(() => {
    if (!open || !selectedProfileId) {
      modelsRequestRef.current += 1
      setModels([])
      setModelsLoading(false)
      return
    }
    void loadModels(selectedProfileId, false)
    return () => {
      modelsRequestRef.current += 1
    }
  }, [loadModels, open, selectedProfileId])

  useEffect(() => {
    const grid = modelGridRef.current
    if (!open || !grid || settings.variant === 'provider-tags') return
    const updateColumns = () => {
      setModelGridColumns(getBalancedModelGridColumns(models.length, grid.clientWidth, grid.clientHeight))
    }
    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [models.length, open, settings.variant])

  if (!open || !settings.enabled) return null

  const rememberRecent = (profileId: string) => {
    updateSettings({
      recentProfileIds: [profileId, ...settings.recentProfileIds.filter((id) => id !== profileId)].slice(0, 8),
    })
  }

  const selectProfile = (profile: ConnectionProfile) => {
    setSelectedProfileId(profile.id)
    setActiveProfile(profile.id)
    rememberRecent(profile.id)
  }

  const selectModel = async (model: string) => {
    if (!selectedProfile) return
    const updated = await connectionsApi.update(selectedProfile.id, { model })
    updateProfile(selectedProfile.id, updated)
    setActiveProfile(selectedProfile.id)
    rememberRecent(selectedProfile.id)
  }

  const toggleFavoriteModel = async (model: string) => {
    if (!selectedProfile) return
    const nextFavorites = favoriteModelSet.has(model)
      ? favoriteModels.filter((favoriteModel) => favoriteModel !== model)
      : [...favoriteModels, model]
    const nextProfile = setConnectionProfileFavoriteModels(selectedProfile, nextFavorites)
    const updated = await connectionsApi.update(selectedProfile.id, { metadata: nextProfile.metadata })
    updateProfile(selectedProfile.id, updated)
  }

  const toggleFavorite = (profileId: string) => {
    const favoriteProfileIds = settings.favoriteProfileIds.includes(profileId)
      ? settings.favoriteProfileIds.filter((id) => id !== profileId)
      : [...settings.favoriteProfileIds, profileId]
    updateSettings({ favoriteProfileIds })
  }

  const startColumnResize = (key: 'profiles' | 'models', event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = settings.columnWidths[key] ?? (key === 'profiles' ? 180 : 220)
    let nextWidth = startWidth

    /*
     * The drag paints straight onto the CSS custom property and commits to the
     * store once, on release. `connectionsPickerSettings` is a DATA_KEY
     * (store/slices/settings.ts:133), so the previous per-pointermove
     * `setSetting` re-rendered the whole picker AND queued a debounced server
     * write 60-120 times a second while the handle was held.
     */
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      nextWidth = clampColumnWidth(
        startWidth + (key === 'models' ? -delta : delta),
        key,
        settings.variant,
        settings.rect.width,
      )
      pickerRef.current?.style.setProperty(COLUMN_WIDTH_VAR[key], `${nextWidth}px`)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (nextWidth !== startWidth) {
        updateSettings({ columnWidths: { ...settings.columnWidths, [key]: nextWidth } })
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const renderProfile = (profile: ConnectionProfile) => {
    const active = profile.id === activeProfileId
    const favorite = settings.favoriteProfileIds.includes(profile.id)
    return (
      <div
        key={profile.id}
        className={clsx(styles.profileRow, active && styles.profileRowActive)}
        data-profile-id={profile.id}
        data-profile-active={active ? 'true' : 'false'}
      >
        <button type="button" className={styles.profileMain} onClick={() => selectProfile(profile)}>
          <span className={styles.profileIcon} style={{ width: settings.thumbnailSize, height: settings.thumbnailSize }}>
            <Link2 size={Math.max(14, settings.thumbnailSize - 10)} />
          </span>
          <span className={styles.profileText}>
            <strong>{profile.name}</strong>
            {settings.showModelMetadata && <small>{profile.provider} / {profile.model || 'No model selected'}</small>}
          </span>
          {active ? <Check size={16} /> : <ChevronRight size={15} />}
        </button>
        <button
          type="button"
          className={clsx(styles.starButton, favorite && styles.starButtonActive)}
          onClick={() => toggleFavorite(profile.id)}
          aria-label={favorite ? `Remove ${profile.name} from favorites` : `Favorite ${profile.name}`}
        >
          <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
    )
  }

  const renderProfileCard = (profile: ConnectionProfile) => {
    const active = profile.id === activeProfileId
    const favorite = settings.favoriteProfileIds.includes(profile.id)
    return (
      <article key={profile.id} className={clsx(styles.profileCard, active && styles.profileCardActive)}>
        <button type="button" className={styles.profileCardMain} onClick={() => selectProfile(profile)}>
          <span className={styles.profileCardIcon} style={{ width: settings.thumbnailSize + 10, height: settings.thumbnailSize + 10 }}>
            <Link2 size={Math.max(16, settings.thumbnailSize - 6)} />
          </span>
          <span className={styles.profileCardText}>
            <strong>{profile.name}</strong>
            {settings.showModelMetadata && <small>{profile.model || 'No model selected'}</small>}
          </span>
          {active && <Check size={16} className={styles.profileCardCheck} />}
        </button>
        <button
          type="button"
          className={clsx(styles.cardStarButton, favorite && styles.starButtonActive)}
          onClick={() => toggleFavorite(profile.id)}
          aria-label={favorite ? `Remove ${profile.name} from favorites` : `Favorite ${profile.name}`}
        >
          <Star size={16} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </article>
    )
  }

  const providerTagControls = visibleTags.length > 0 && (
    <div className={styles.tags}>
      <button
        type="button"
        className={clsx(styles.tagButton, selectedTagId === null && styles.tagButtonActive)}
        onClick={() => setSelectedTagId(null)}
      >
        All
      </button>
      {visibleTags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          className={clsx(styles.tagButton, selectedTagId === tag.id && styles.tagButtonActive)}
          style={{ '--tag-color': tag.color } as CSSProperties}
          onClick={() => setSelectedTagId(tag.id)}
        >
          {tag.name}
        </button>
      ))}
    </div>
  )

  const selectProviderTab = (tab: ProviderTab) => {
    setProviderTab(tab)
    setSelectedTagId(tab.startsWith('tag:') ? tab.slice(4) : null)
    if (!tab.startsWith('tag:')) return
    const tagId = tab.slice(4)
    const firstTaggedProfile = filterConnectionProfiles(profiles, settings.profileTags, query, tagId)[0]
    if (firstTaggedProfile) setSelectedProfileId(firstTaggedProfile.id)
  }

  const providerTabs = (
    <div className={styles.providerTabs}>
      {settings.showFavorites && (
        <button
          type="button"
          className={clsx(styles.providerTab, providerTab === 'favorites' && styles.providerTabActive)}
          onClick={() => selectProviderTab('favorites')}
        >
          Favorites
        </button>
      )}
      {settings.showRecent && (
        <button
          type="button"
          className={clsx(styles.providerTab, providerTab === 'recent' && styles.providerTabActive)}
          onClick={() => selectProviderTab('recent')}
        >
          Recent
        </button>
      )}
      {visibleTags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          className={clsx(styles.providerTab, providerTab === `tag:${tag.id}` && styles.providerTabActive)}
          style={{ '--tag-color': tag.color } as CSSProperties}
          onClick={() => selectProviderTab(`tag:${tag.id}`)}
        >
          #{tag.name}
        </button>
      ))}
      <button
        type="button"
        className={clsx(styles.providerTab, providerTab === 'all' && styles.providerTabActive)}
        onClick={() => selectProviderTab('all')}
      >
        All
      </button>
      <button
        type="button"
        className={styles.providerSearchButton}
        onClick={() => setProviderSearchOpen((value) => !value)}
        aria-label="Search connections"
      >
        <Search size={17} />
      </button>
    </div>
  )

  const activeProfileSummary = selectedProfile && (
    <div className={styles.activeSummary}>
      <span className={styles.activeSummaryIcon}><Link2 size={15} /></span>
      <span className={styles.activeSummaryText}>
        <strong>{selectedProfile.name}</strong>
        <small>{selectedProfile.provider} / {selectedProfile.model || 'No model selected'}</small>
      </span>
      <Check size={16} />
    </div>
  )

  const modelsPanel = (
    <section className={styles.modelsPanel}>
      <div className={styles.modelsHeading}>
        <h3>Models</h3>
        {selectedProfile && <span>{selectedProfile.provider}</span>}
        <label className={styles.modelsHeadingSearch}>
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return
              event.preventDefault()
              setQuery('')
            }}
            placeholder="Search models..."
            aria-label="Search models"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className={styles.modelsHeadingActions}>
          <button
            type="button"
            className={styles.headerButton}
            onClick={() => { if (selectedProfileId) void loadModels(selectedProfileId, true) }}
            title="Refresh models"
            aria-label="Refresh models"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.headerButton, modelLayout === 'grid' && styles.variantButtonActive)}
            onClick={() => updateSettings({ modelLayout: 'grid' })}
            title="Grid layout"
            aria-label="Grid layout"
            aria-pressed={modelLayout === 'grid'}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.headerButton, modelLayout === 'list' && styles.variantButtonActive)}
            onClick={() => updateSettings({ modelLayout: 'list' })}
            title="List layout"
            aria-label="List layout"
            aria-pressed={modelLayout === 'list'}
          >
            <List size={14} />
          </button>
        </div>
      </div>
      {modelsLoading && <div className={styles.empty} data-models-loading="true"><LoaderCircle className={styles.spinner} size={18} /> Loading models...</div>}
      {!modelsLoading && models.length > 0 && (
        <div
          ref={modelGridRef}
          className={clsx(styles.modelsGrid, modelLayout === 'list' && styles.modelsList)}
          data-model-layout={modelLayout}
          data-visible-models={visibleModels.join(',')}
          style={{
            '--connections-model-grid-columns': modelLayout === 'list' ? 1 : modelGridColumns,
            ...(modelLayout === 'list' ? { display: 'flex', flexDirection: 'column', overflow: 'auto' } : {}),
          } as CSSProperties}
        >
          {visibleModels.map((model) => {
            const selected = selectedProfile?.model === model
            const favorite = favoriteModelSet.has(model)
            return (
              <div key={model} className={clsx(styles.modelTile, selected && styles.modelButtonActive)}>
                <button type="button" className={styles.modelButton} onClick={() => void selectModel(model)}>
                  <span>{modelLabels[model] || model}</span>
                  {selected && <Check size={16} />}
                </button>
                <button
                  type="button"
                  className={clsx(styles.modelFavoriteButton, favorite && styles.modelFavoriteButtonActive)}
                  onClick={() => void toggleFavoriteModel(model)}
                  aria-label={`${favorite ? 'Remove' : 'Add'} ${modelLabels[model] || model} ${favorite ? 'from' : 'to'} favorites`}
                  aria-pressed={favorite}
                  title={favorite ? 'Remove favorite model' : 'Favorite model'}
                >
                  <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {!modelsLoading && selectedProfile && models.length === 0 && <div className={styles.empty}>No models returned.</div>}
      {!modelsLoading && selectedProfile && models.length > 0 && visibleModels.length === 0 && <div className={styles.empty}>No matching models.</div>}
      {!selectedProfile && <div className={styles.empty}>Choose a connection to browse models.</div>}
    </section>
  )

  const searchControl = settings.showSearch && (
    <label className={styles.searchBox}>
      <Search size={16} />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search connections, providers, models, tags..."
      />
    </label>
  )

  const manageButton = (
    <button
      type="button"
      className={styles.squareAction}
      onClick={() => openDrawer('connections')}
      title="Manage connections"
      aria-label="Manage connections"
    >
      <Plus size={17} />
    </button>
  )

  const panelFooter = (
    <footer className={styles.panelFooter}>
      <button type="button" onClick={() => openDrawer('connections')}>
        Manage connections
      </button>
      <span>{filteredProfiles.length} connections</span>
      <button type="button" onClick={() => openDrawer('connections')}>
        Open full manager <ExternalLink size={13} />
      </button>
    </footer>
  )

  const switchVariant = (variant: ConnectionsPickerVariant) => {
    if (variant === settings.variant) return

    rememberVariantRect(settings.variant, currentFrameRectRef.current)
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0)
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0)
    const rememberedRect = variantRectsRef.current[variant]
    const rect = resolveConnectionsPickerRect(
      rememberedRect ?? DEFAULT_CONNECTIONS_PICKER_SETTINGS.rect,
      PICKER_BOUNDS[variant],
      viewportWidth,
      viewportHeight,
      !rememberedRect,
    )
    rememberVariantRect(variant, rect)
    updateSettings({ variant, rect, positionInitialized: true })
  }

  const variantSwitcher = (
    <div className={styles.variantSwitch} aria-label="Connections picker variant">
      {VARIANTS.map((variant) => (
        <button
          key={variant.id}
          type="button"
          className={clsx(styles.variantButton, settings.variant === variant.id && styles.variantButtonActive)}
          onClick={() => switchVariant(variant.id)}
          title={`Variant ${variant.label}`}
        >
          {variant.label}
        </button>
      ))}
    </div>
  )

  const variantAModelGrid = providerTabShowsModels && (
    <section className={styles.modelGridSection}>
      {selectedProfile && (
        <div className={styles.modelsHeading}>
          <button
            type="button"
            className={styles.headerButton}
            onClick={() => { if (selectedProfileId) void loadModels(selectedProfileId, true) }}
            title="Refresh models"
            aria-label="Refresh models"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.headerButton, modelLayout === 'grid' && styles.variantButtonActive)}
            onClick={() => updateSettings({ modelLayout: 'grid' })}
            title="Grid layout"
            aria-label="Grid layout"
            aria-pressed={modelLayout === 'grid'}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.headerButton, modelLayout === 'list' && styles.variantButtonActive)}
            onClick={() => updateSettings({ modelLayout: 'list' })}
            title="List layout"
            aria-label="List layout"
            aria-pressed={modelLayout === 'list'}
          >
            <List size={14} />
          </button>
        </div>
      )}
      {selectedProfile && modelsLoading && (
        <div className={styles.empty} data-models-loading="true">
          <LoaderCircle className={styles.spinner} size={18} /> Loading models...
        </div>
      )}
      {selectedProfile && !modelsLoading && models.length > 0 && (
        <div
          className={clsx(styles.modelGrid, modelLayout === 'list' && styles.modelsList)}
          data-model-layout={modelLayout}
          style={modelLayout === 'list' ? { display: 'flex', flexDirection: 'column', overflow: 'auto' } : undefined}
        >
          {visibleModels.map((model) => {
            const selected = selectedProfile.model === model
            return (
              <button
                key={model}
                type="button"
                className={clsx(styles.modelGridButton, selected && styles.modelGridButtonActive)}
                onClick={() => void selectModel(model)}
              >
                <span>{modelLabels[model] || model}</span>
                {selected && <Check size={14} />}
              </button>
            )
          })}
        </div>
      )}
      {selectedProfile && !modelsLoading && models.length === 0 && <div className={styles.empty}>No models returned.</div>}
      {selectedProfile && !modelsLoading && models.length > 0 && visibleModels.length === 0 && <div className={styles.empty}>No matching models.</div>}
      {!selectedProfile && <div className={styles.empty}>No matching connections.</div>}
    </section>
  )

  const frameStyle = {
    '--connections-section-gap': `${settings.sectionSpacing}px`,
    '--connections-profile-width': `${settings.columnWidths.profiles ?? 180}px`,
    '--connections-model-width': `${settings.columnWidths.models ?? 220}px`,
    ...(settings.density === 'custom'
      ? {
          '--row-pad': `${settings.rowPadding}px`,
          '--row-gap': `${settings.rowGap}px`,
        }
      : {}),
  } as CSSProperties

  const rememberedFrameRect = variantRectsRef.current[settings.variant] ?? settings.rect
  let frameRect = rememberedFrameRect
  if (settings.variant === 'provider-tags' && anchorElement) {
    const providerRect = {
      ...rememberedFrameRect,
      height: getProviderTagsPickerHeight(
        rememberedFrameRect.height,
        settings.showSearch && providerSearchOpen,
        providerTabShowsModels,
      ),
    }
    const anchorSurface = anchorElement.closest<HTMLElement>('[data-component="InputArea"]') ?? anchorElement
    const anchorRect = anchorSurface.getBoundingClientRect()
    frameRect = resolveAnchoredConnectionsPickerRect(
      providerRect,
      PICKER_BOUNDS['provider-tags'],
      Math.max(document.documentElement.clientWidth, window.innerWidth || 0),
      Math.max(document.documentElement.clientHeight, window.innerHeight || 0),
      anchorRect,
    )
  }
  currentFrameRectRef.current = frameRect

  const navigateProviderCards = (direction: -1 | 1) => {
    const rail = cardRailRef.current
    if (!rail) return

    const atStart = rail.scrollLeft <= 8
    const atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8
    const pageSize = Math.max(160, rail.clientWidth - 180)
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth)
    rail.scrollTo({
      left: direction < 0
        ? atStart ? maxScroll : Math.max(0, rail.scrollLeft - pageSize)
        : atEnd ? 0 : Math.min(maxScroll, rail.scrollLeft + pageSize),
      behavior: 'smooth',
    })
  }

  const picker = (
    <ResizablePanelFrame
      rect={frameRect}
      bounds={PICKER_BOUNDS[settings.variant]}
      onCommit={(rect) => {
        rememberVariantRect(settings.variant, rect)
        currentFrameRectRef.current = rect
        updateSettings({ rect })
      }}
      title="Connections Picker"
      aria-label="Connections Picker"
      persistGeometry="connections_picker"
      showHeader={settings.variant !== 'provider-tags'}
      toolbar={(
        <>
          {variantSwitcher}
          <button type="button" className={styles.headerButton} onClick={() => openDrawer('connections')} title="Manage connections">
            <Settings2 size={15} />
          </button>
          <button type="button" className={styles.headerButton} onClick={onClose} title="Close connections picker">
            <X size={16} />
          </button>
        </>
      )}
      className={styles.frame}
    >
      <div ref={pickerRef} className={clsx(styles.picker, DENSITY_CLASS[settings.density])} style={frameStyle}>
        {settings.showSearch && settings.variant === 'provider-tags' && providerSearchOpen && (
          <label className={styles.searchBox}>
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connections, providers, models, tags..."
            />
          </label>
        )}
        {settings.variant === 'provider-tags' && (
          <div className={styles.tagVariant}>
            <div className={styles.variantATop}>
              {activeProfileSummary}
              <div className={styles.variantAControls}>
                {variantSwitcher}
                <button type="button" className={styles.headerButton} onClick={() => openDrawer('connections')} title="Manage connections">
                  <Settings2 size={15} />
                </button>
                <button type="button" className={styles.headerButton} onClick={onClose} title="Close connections picker">
                  <X size={16} />
                </button>
              </div>
            </div>
            {providerTabs}
            <div className={styles.cardSections}>
              {providerTabShowsModels
                ? variantAModelGrid
                : (
                    <section>
                      <div className={styles.cardRailViewport}>
                        <div ref={cardRailRef} className={styles.cardRail}>
                          {variantAProfiles.map(renderProfileCard)}
                        </div>
                        {variantAProfiles.length > 1 && (
                          <>
                            <button
                              type="button"
                              className={clsx(styles.cardRailArrow, styles.cardRailPrevious)}
                              onClick={() => navigateProviderCards(-1)}
                              aria-label="Show previous connections"
                              title="Show previous connections"
                            >
                              <ChevronLeft size={18} />
                            </button>
                            <button
                              type="button"
                              className={clsx(styles.cardRailArrow, styles.cardRailNext)}
                              onClick={() => navigateProviderCards(1)}
                              aria-label="Show next connections"
                              title="Show next connections"
                            >
                              <ChevronRight size={18} />
                            </button>
                          </>
                        )}
                      </div>
                      {variantAProfiles.length === 0 && <div className={styles.empty}>No matching connections.</div>}
                    </section>
                  )}
            </div>
          </div>
        )}
        {settings.variant === 'split' && (
          <div className={styles.splitVariant}>
            <div className={styles.variantToolbar}>
              {searchControl}
              {manageButton}
            </div>
            <div className={styles.splitBody}>
              <div className={styles.splitConnectionsPane}>
                <div className={styles.connectionCatalog}>
                  {selectedProfile && (
                    <section>
                      <h3>Active</h3>
                      {renderProfile(selectedProfile)}
                    </section>
                  )}
                  <section>
                    <h3>Saved</h3>
                    {savedProfiles.map(renderProfile)}
                    {savedProfiles.length === 0 && <div className={styles.empty}>No saved connections.</div>}
                  </section>
                  {settings.showRecent && recentProfiles.length > 0 && (
                    <section>
                      <h3>Recent</h3>
                      {recentProfiles.map(renderProfile)}
                    </section>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={styles.columnResizer}
                aria-label="Resize connection list"
                onPointerDown={(event) => startColumnResize('profiles', event)}
              />
              {modelsPanel}
            </div>
            {panelFooter}
          </div>
        )}
        {settings.variant === 'full' && (
          <div className={styles.fullVariant}>
            <div className={styles.variantToolbar}>
              {searchControl}
              {manageButton}
            </div>
            {providerTagControls}
            <div className={styles.fullBody}>
              <div className={styles.favoriteColumn}>
                <section>
                  <h3>Favorites</h3>
                  {favoriteProfiles.map(renderProfile)}
                  {favoriteProfiles.length === 0 && <div className={styles.empty}>No favorites yet.</div>}
                </section>
                {settings.showRecent && (
                  <section>
                    <h3>Recent</h3>
                    {recentProfiles.map(renderProfile)}
                    {recentProfiles.length === 0 && <div className={styles.empty}>No recent connections.</div>}
                  </section>
                )}
              </div>
              <button
                type="button"
                className={styles.columnResizer}
                aria-label="Resize favorites and recent"
                onPointerDown={(event) => startColumnResize('profiles', event)}
              />
              <div className={styles.profileColumn}>
                <section>
                  <h3>All Connections</h3>
                  {filteredProfiles.map(renderProfile)}
                  {filteredProfiles.length === 0 && <div className={styles.empty}>No matching connections.</div>}
                </section>
              </div>
              <button
                type="button"
                className={styles.columnResizer}
                aria-label="Resize models"
                onPointerDown={(event) => startColumnResize('models', event)}
              />
              {modelsPanel}
            </div>
            {panelFooter}
          </div>
        )}
      </div>
    </ResizablePanelFrame>
  )

  const portalStyle = {
    '--connections-picker-opacity': settings.opacity,
  } as CSSProperties

  return createPortal(
    <div className={styles.portalLayer} style={portalStyle} data-component="ConnectionsPicker">
      {picker}
    </div>,
    document.body,
  )
}

export function ConnectionsPicker(props: ConnectionsPickerProps) {
  return useSpindleComponentOverride('ConnectionsPicker', ConnectionsPickerNative, props)
}
