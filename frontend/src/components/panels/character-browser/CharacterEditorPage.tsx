import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import {
  X,
  Upload,
  Trash2,
  Copy,
  MessageSquare,
  User,
  UserPlus,
  Plus,
  ImagePlus,
  Download,
  Code2,
  GripVertical,
  ExternalLink,
  Hash,
  MoreHorizontal,
  CircleHelp,
  Pencil,
} from 'lucide-react'
import {
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { IconNotebook } from '@tabler/icons-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import VirtualGrid from '@/components/shared/VirtualGrid'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import TokenCountButton from '@/components/shared/TokenCountButton'
import { charactersApi, type CharacterPerspectiveLayerInput } from '@/api/characters'
import { ApiError } from '@/api/client'
import { characterGalleryApi } from '@/api/character-gallery'
import { isImageDeleted, onImageDeleted, isGalleryItemRemoved, onGalleryItemRemoved } from '@/lib/deletion-events'
import { imagesApi } from '@/api/images'
import { personasApi } from '@/api/personas'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import CharacterTagInput from './CharacterTagInput'
import { uuidv7 } from '@/lib/uuid'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import ImageCropModal from '@/components/shared/ImageCropModal'
import ImageLightbox from '@/components/shared/ImageLightbox'
import LazyImage from '@/components/shared/LazyImage'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import CardUpdateModal from '@/components/modals/CardUpdateModal'
import { useLongPress } from '@/hooks/useLongPress'
import type { CardUpdateApplySummary, CardUpdatePreview, Character, CharacterGalleryItem, WorldBook } from '@/types/api'
import type { WallpaperRef } from '@/types/store'
import { toast } from '@/lib/toast'
import { hasNativeDownloadCompletion } from '@/lib/downloads'
import { copyTextToClipboard } from '@/lib/clipboard'
import { galleryImageMarkdown } from '@/lib/galleryImageReference'
import { getTauriMobilePlatform } from '@/lib/desktopWebView'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { Button } from '@/components/shared/FormComponents'
import { RangeSlider } from '@/components/shared/RangeSlider'
import SearchableSelect from '@/components/shared/SearchableSelect'
import VoicePicker from '@/components/shared/VoicePicker'
import FolderDropdown from '@/components/shared/FolderDropdown'
import SpindleCharacterEditorTabContent from '@/components/spindle/SpindleCharacterEditorTabContent'
import { ttsConnectionsApi } from '@/api/tts-connections'
import type { VoiceRef } from '@/types/api'
import { filterWorldBooksForChatContextAttachment } from '@/lib/worldBookIndexPrompt'
import { DndContext, useScaledSortableStyle } from '@/lib/dndUiScale'
import { useFolders } from '@/hooks/useFolders'
import { setCharacterEditorController, syncCharacterEditorState } from '@/lib/spindle/character-editor-helper'
import { applyChatAppearance } from '@/lib/chatAppearance'
import { setAlternateFieldVariants, type AvatarBindingField, type AvatarBindings } from '@/lib/avatarBindings'
import styles from './CharacterEditorPage.module.css'
import clsx from 'clsx'
import {
  getCharacterWorldBookIds,
  getEmbeddedCharacterBookEntryCount,
  setCharacterWorldBookIds,
} from '@/utils/character-world-books'
import ExpressionEditorTab from './ExpressionEditorTab'
import CharacterLoraTab from './CharacterLoraTab'
import AlternateFieldEditor from './AlternateFieldEditor'
import AlternateAvatarManager from './AlternateAvatarManager'
import type { AlternateAvatarEntry } from './AlternateAvatarManager'
import { uploadAlternateAvatar } from '@/lib/alternateAvatarUpload'
import CharacterTokenReportModal, { type CharacterTokenReportItem } from './CharacterTokenReportModal'
import { GuideViewer } from '@/components/shared/GuideViewer'
import {
  getGreetingTitle,
  moveAlternateGreetingMetadata,
  remapGreetingIndexForMove,
  removeAlternateGreetingMetadata,
  setGreetingTitle,
} from '@/lib/greetingMetadata'
import {
  parseCharacterSourceInput,
  readCharacterSourceUrl,
  readChubFullPath,
  setCharacterSource,
} from '@/lib/characterSource'

const DEBOUNCE_MS = 2000
const MAX_PERSPECTIVE_LAYERS = 5
const GALLERY_MIN_ITEM_WIDTH = 120
const GALLERY_GAP = 8

interface CharxExportProgress {
  characterId?: string
  exportId?: string
  phase: 'preparing' | 'collecting_assets' | 'compressing' | 'complete' | 'failed'
  completed?: number
  total?: number
  error?: string
}
const GALLERY_OVERSCAN = 3
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const IMAGE_PATH_RE = /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jfif|pjp|pjpeg|png|svg|webp)$/i

type BuiltInTabId = 'core' | 'system' | 'greetings' | 'identity' | 'gallery' | 'expressions' | 'voice' | 'imageLora' | 'advanced'
type TabId = BuiltInTabId | string

interface GalleryGridItemProps {
  item: CharacterGalleryItem
  onRemove: (itemId: string) => void
  deleting: boolean
  onOpenMenu: (item: CharacterGalleryItem, pos: ContextMenuPos) => void
  onPreview: (item: CharacterGalleryItem) => void
}

function GalleryGridItem({ item, onRemove, deleting, onOpenMenu, onPreview }: GalleryGridItemProps) {
  const { t } = useTranslation('panels')
  const longPress = useLongPress({
    onLongPress: (pos) => onOpenMenu(item, pos),
  })

  return (
    <div
      className={styles.galleryItem}
      role="button"
      tabIndex={0}
      aria-label={item.caption || t('characterEditor.galleryImage')}
      onClick={() => onPreview(item)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPreview(item)
        }
      }}
      {...longPress}
    >
      <LazyImage
        src={characterGalleryApi.smallUrl(item.image_id)}
        alt={item.caption || t('characterEditor.galleryImage')}
        className={styles.galleryThumb}
        fallback={<div className={styles.galleryThumbPlaceholder} />}
      />
      <span className={styles.galleryReferenceBadge} title={item.reference}>
        {item.reference.replace(/^gallery:\/\//, '')}
      </span>
      <button
        type="button"
        className={styles.galleryRemoveBtn}
        disabled={deleting}
        aria-busy={deleting}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(item.id)
        }}
        title={t('characterEditor.removeFromGallery')}
      >
        {deleting ? <Spinner size={12} /> : <X size={12} />}
      </button>
    </div>
  )
}

interface SortablePerspectiveLayerProps {
  layer: CharacterPerspectiveLayerInput
  index: number
  disabled: boolean
  onLabelChange: (layerId: string, label: string) => void
  onIntensityChange: (layerId: string, intensity: number) => void
  onRemove: (layerId: string) => void
}

function SortablePerspectiveLayer({ layer, index, disabled, onLabelChange, onIntensityChange, onRemove }: SortablePerspectiveLayerProps) {
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: layer.id, disabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const [liveIntensity, setLiveIntensity] = useState<number | null>(null)
  const [draftLabel, setDraftLabel] = useState(layer.label || '')
  const intensity = liveIntensity ?? layer.intensity

  useEffect(() => {
    setDraftLabel(layer.label || '')
  }, [layer.label])

  const commitLabel = useCallback(() => {
    if (draftLabel !== (layer.label || '')) onLabelChange(layer.id, draftLabel)
  }, [draftLabel, layer.id, layer.label, onLabelChange])

  return (
    <div ref={setNodeRef} style={style} className={clsx(styles.perspectiveLayerRow, isDragging && styles.perspectiveLayerDragging)}>
      <button type="button" className={styles.perspectiveLayerDrag} disabled={disabled} {...attributes} {...listeners} title="Drag to reorder">
        <GripVertical size={16} />
      </button>
      <div className={styles.perspectiveLayerRowPreview}>
        <LazyImage
          src={imagesApi.smallUrl(layer.image_id)}
          alt={layer.label || `Layer ${index + 1}`}
          className={styles.perspectiveLayerRowImg}
          fallback={<div className={styles.perspectiveLayerEmpty}><ImagePlus size={16} /></div>}
        />
      </div>
      <div className={styles.perspectiveLayerRowBody}>
        <div className={styles.perspectiveLayerRowTop}>
          <input
            type="text"
            className={styles.perspectiveLayerNameInput}
            value={draftLabel}
            placeholder={`Layer ${index + 1}`}
            onChange={(e) => setDraftLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
          <button type="button" className={styles.perspectiveLayerRemove} onClick={() => onRemove(layer.id)} title="Remove layer">
            <X size={12} />
          </button>
        </div>
        <div className={styles.perspectiveLayerSliderRow}>
          <div className={styles.perspectiveLayerSliderHeader}>
            <span>Parallax strength</span>
            <span>{intensity.toFixed(2)}x</span>
          </div>
          <RangeSlider
            min={0}
            max={1.5}
            step={0.05}
            value={layer.intensity}
            onDragValue={setLiveIntensity}
            onCommit={(value) => {
              setLiveIntensity(null)
              onIntensityChange(layer.id, value)
            }}
          />
        </div>
      </div>
    </div>
  )
}

function SortableGreetingItem({
  id,
  disabled,
  children,
}: {
  id: string
  disabled: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslation('panels')
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id, disabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(styles.greetingItem, styles.greetingItemSortable, isDragging && styles.greetingItemDragging)}
    >
      <button
        type="button"
        className={styles.greetingDragHandle}
        disabled={disabled}
        title={t('characterEditor.reorderGreeting')}
        aria-label={t('characterEditor.reorderGreeting')}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} />
      </button>
      {children}
    </div>
  )
}

function GreetingNameInput({
  value,
  resetKey,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: string
  resetKey: string
  placeholder: string
  ariaLabel?: string
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [resetKey, value])

  return (
    <input
      type="text"
      className={styles.greetingNameInput}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        onChange(event.target.value)
      }}
      onBlur={() => setDraft(value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  )
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function trimTrailingUrlPunctuation(url: string): string {
  let trimmed = url.trim()

  while (/[.,!?;:]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1)
  }

  while (trimmed.endsWith(')') && ((trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0))) {
    trimmed = trimmed.slice(0, -1)
  }

  while (trimmed.endsWith(']') && ((trimmed.match(/\[/g)?.length ?? 0) < (trimmed.match(/\]/g)?.length ?? 0))) {
    trimmed = trimmed.slice(0, -1)
  }

  return trimmed
}

function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && IMAGE_PATH_RE.test(parsed.pathname)
  } catch {
    return false
  }
}

function extractEmbeddedImageUrls(text: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  let match: RegExpExecArray | null

  const push = (url: string) => {
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }

  MD_IMAGE_RE.lastIndex = 0
  while ((match = MD_IMAGE_RE.exec(text)) !== null) push(match[1])

  HTML_IMG_RE.lastIndex = 0
  while ((match = HTML_IMG_RE.exec(text)) !== null) push(match[1])

  BARE_URL_RE.lastIndex = 0
  while ((match = BARE_URL_RE.exec(text)) !== null) {
    const candidate = trimTrailingUrlPunctuation(match[0])
    if (isDirectImageUrl(candidate)) push(candidate)
  }

  return urls
}

function readPerspectiveLayers(raw: unknown): CharacterPerspectiveLayerInput[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is CharacterPerspectiveLayerInput => {
        return Boolean(entry)
          && typeof entry === 'object'
          && typeof (entry as CharacterPerspectiveLayerInput).id === 'string'
          && typeof (entry as CharacterPerspectiveLayerInput).image_id === 'string'
      })
      .slice(0, MAX_PERSPECTIVE_LAYERS)
      .map((entry) => ({
        id: entry.id,
        image_id: entry.image_id,
        label: typeof entry.label === 'string' ? entry.label : undefined,
        intensity: typeof entry.intensity === 'number' && Number.isFinite(entry.intensity)
          ? Math.max(0, Math.min(1.5, entry.intensity))
          : 0.6,
      }))
  }

  if (raw && typeof raw === 'object') {
    const legacy = raw as Record<string, string | undefined>
    return [
      legacy.background ? { id: 'background', image_id: legacy.background, label: 'Background', intensity: 0.15 } : null,
      legacy.framing ? { id: 'framing', image_id: legacy.framing, label: 'Framing', intensity: 1 } : null,
      legacy.subject ? { id: 'subject', image_id: legacy.subject, label: 'Subject', intensity: 0.6 } : null,
    ].filter(Boolean) as CharacterPerspectiveLayerInput[]
  }

  return []
}

function clonePerspectiveLayers(layers: CharacterPerspectiveLayerInput[]): CharacterPerspectiveLayerInput[] {
  return layers.map((layer) => ({ ...layer }))
}

function arePerspectiveLayersEqual(
  a: CharacterPerspectiveLayerInput[],
  b: CharacterPerspectiveLayerInput[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((layer, index) => {
    const other = b[index]
    return other != null
      && layer.id === other.id
      && layer.image_id === other.image_id
      && (layer.label ?? '') === (other.label ?? '')
      && layer.intensity === other.intensity
  })
}

export default function CharacterEditorPage() {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')

  const builtInTabs = useMemo<{ id: BuiltInTabId; label: string }[]>(() => [
    { id: 'core', label: t('characterEditor.tabs.core') },
    { id: 'system', label: t('characterEditor.tabs.system') },
    { id: 'greetings', label: t('characterEditor.tabs.greetings') },
    { id: 'identity', label: t('characterEditor.tabs.identity') },
    { id: 'gallery', label: t('characterEditor.tabs.gallery') },
    { id: 'expressions', label: t('characterEditor.tabs.expressions') },
    { id: 'voice', label: t('characterEditor.tabs.voice') },
    { id: 'imageLora', label: t('characterEditor.tabs.imageLora') },
    { id: 'advanced', label: t('characterEditor.tabs.advanced') },
  ], [t])

  const editingCharacterId = useStore((s) => s.editingCharacterId)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const openDrawer = useStore((s) => s.openDrawer)
  const addPersona = useStore((s) => s.addPersona)
  const updatePersona = useStore((s) => s.updatePersona)
  const setSelectedPersonaId = useStore((s) => s.setSelectedPersonaId)
  const setPendingWorldBookEditId = useStore((s) => s.setPendingWorldBookEditId)
  const allCharacters = useStore((s) => s.characters)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const setActiveChatWallpaper = useStore((s) => s.setActiveChatWallpaper)
  const setSceneBackground = useStore((s) => s.setSceneBackground)
  const updateCharInStore = useStore((s) => s.updateCharacter)
  const characterEditorTabs = useStore((s) => s.characterEditorTabs)
  const regexScripts = useStore((s) => s.regexScripts)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const browser = useCharacterBrowser()
  const { folders: characterFolders, createFolder: createCharacterFolder } = useFolders('characterFolders', allCharacters)

  const character = allCharacters.find((c) => c.id === editingCharacterId) ?? null
  const isOpen = !!editingCharacterId
  const [characterLoadError, setCharacterLoadError] = useState<{ id: string; message: string } | null>(null)
  const tabs = useMemo<{ id: TabId; label: string }[]>(() => [
    ...builtInTabs,
    ...characterEditorTabs.map((tab) => ({ id: tab.id, label: tab.title })),
  ], [builtInTabs, characterEditorTabs])

  const [activeTab, setActiveTab] = useState<TabId>('core')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string[]>([])
  const [guideOpen, setGuideOpen] = useState(false)
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([])
  const [alternateGreetingIds, setAlternateGreetingIds] = useState<string[]>([])
  const [greetingBackgroundPickerIndex, setGreetingBackgroundPickerIndex] = useState<number | null>(null)
  const [alternateCharacterName, setAlternateCharacterName] = useState('')
  const [sourceLinkDraft, setSourceLinkDraft] = useState('')
  const [sourceLinkError, setSourceLinkError] = useState<string | null>(null)
  const [extensionsJson, setExtensionsJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showTokenReport, setShowTokenReport] = useState(false)
  const [pendingCardUpdate, setPendingCardUpdate] = useState<{ file: File; preview: CardUpdatePreview } | null>(null)
  const [avatarKey, setAvatarKey] = useState(0)
  const [lorebookImporting, setLorebookImporting] = useState(false)
  const [lorebookResult, setLorebookResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [galleryDeletingIds, setGalleryDeletingIds] = useState<Set<string>>(new Set())
  const galleryPendingRemovals = useRef(new Set<string>())
  const [galleryLightboxSrc, setGalleryLightboxSrc] = useState<string | null>(null)
  const [worldBooks, setWorldBooks] = useState<Array<Pick<WorldBook, 'id' | 'name' | 'folder' | 'metadata'>>>([])
  const [galleryUploading, setGalleryUploading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [creatingPersona, setCreatingPersona] = useState(false)
  const [replacingCard, setReplacingCard] = useState(false)
  const [galleryContextMenu, setGalleryContextMenu] = useState<{ pos: ContextMenuPos; item: CharacterGalleryItem } | null>(null)
  const [galleryRenameItem, setGalleryRenameItem] = useState<CharacterGalleryItem | null>(null)
  const [galleryRenaming, setGalleryRenaming] = useState(false)
  const [avatarUploadProgress, setAvatarUploadProgress] = useState<number | null>(null)
  const [altAvatarUploadProgress, setAltAvatarUploadProgress] = useState<number | null>(null)
  const [perspectiveLayerProgress, setPerspectiveLayerProgress] = useState<number | null>(null)
  const [localPerspectiveLayers, setLocalPerspectiveLayers] = useState<CharacterPerspectiveLayerInput[]>([])
  const pendingLayersRef = useRef<CharacterPerspectiveLayerInput[]>([])
  const syncedPerspectiveLayersRef = useRef<CharacterPerspectiveLayerInput[]>([])
  const skipPerspectiveLayerFlushRef = useRef(false)
  const layersSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layerSaveLockRef = useRef<Promise<void> | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const cardReplaceFileRef = useRef<HTMLInputElement>(null)
  const perspectiveLayerFileRef = useRef<HTMLInputElement>(null)
  const galleryFileRef = useRef<HTMLInputElement>(null)
  const galleryScrollRef = useRef<HTMLDivElement>(null)
  const [galleryGridWidth, setGalleryGridWidth] = useState(0)
  const savingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastSyncedId = useRef<string | null>(null)

  const close = useCallback(() => {
    setCharacterLoadError(null)
    setEditingCharacterId(null)
  }, [setEditingCharacterId])
  const perspectiveLayerSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.defaultPrevented || pendingCardUpdate) return
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, close, pendingCardUpdate])

  useEffect(() => {
    if (!editingCharacterId || character) return
    let cancelled = false
    charactersApi.get(editingCharacterId).then((loaded) => {
      if (!cancelled && !useStore.getState().characters.some((item) => item.id === loaded.id)) {
        updateCharInStore(loaded.id, loaded)
      }
    }).catch((error: unknown) => {
      if (cancelled) return
      setCharacterLoadError({
        id: editingCharacterId,
        message: error instanceof ApiError && error.status === 404
          ? t('characterEditor.notFound')
          : error instanceof Error ? error.message : t('characterEditor.notFound'),
      })
    })
    return () => { cancelled = true }
  }, [editingCharacterId, character, updateCharInStore, t])

  /// Guide Viewer 
  useEffect(() => {
  setGuideOpen(false)
}, [activeTab])

  // Reset tab and force re-sync when switching to a different character.
  // Keyed on editingCharacterId (a stable string) so store-driven object
  // reference changes can never accidentally reset the active tab.
  useEffect(() => {
    lastSyncedId.current = null
    setGalleryContextMenu(null)
    setGalleryRenameItem(null)
    setGalleryLightboxSrc(null)
    if (editingCharacterId) {
      setActiveTab('core')
    }
    setShowTokenReport(false)
  }, [editingCharacterId])

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return
    setActiveTab('core')
  }, [activeTab, tabs])

  // Sync form fields from character data — runs when the character object
  // changes, but the lastSyncedId guard skips redundant syncs for the same
  // character (e.g. after our own debounced save updates the store).
  useEffect(() => {
    if (!character) return
    if (lastSyncedId.current === character.id) return
    lastSyncedId.current = character.id
    setName(character.name)
    setFolder(character.folder || '')
    setFields({
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      system_prompt: character.system_prompt || '',
      post_history_instructions: character.post_history_instructions || '',
      first_mes: character.first_mes || '',
      mes_example: character.mes_example || '',
      creator: character.creator || '',
      creator_notes: character.creator_notes || '',
    })
    setTags(character.tags || [])
    setAlternateGreetings(character.alternate_greetings || [])
    setAlternateGreetingIds((character.alternate_greetings || []).map(() => uuidv7()))
    setGreetingBackgroundPickerIndex(null)
    setAlternateCharacterName(character.extensions?.alternate_character_name || '')
    setSourceLinkDraft(readCharacterSourceUrl(character.extensions) || '')
    setSourceLinkError(null)
    setExtensionsJson(JSON.stringify(character.extensions || {}, null, 2))
    setJsonError(null)
    pendingExtensionsRef.current = null
    clearTimeout(timers.current['extensions'])
    setLorebookImporting(false)
    setLorebookResult(null)
  }, [character])

  const showSaving = useCallback(() => {
    setSaving(true)
    clearTimeout(savingTimer.current)
    savingTimer.current = setTimeout(() => setSaving(false), 1000)
  }, [])

  const handleFolderChange = useCallback(async (value: string) => {
    if (!character) return
    const previous = folder
    setFolder(value)
    showSaving()
    try {
      await browser.updateCharacter(character.id, { folder: value })
    } catch (err: any) {
      setFolder(previous)
      toast.error(err?.body?.error || err?.message || t('characterEditor.folderSaveFailed'))
    }
  }, [browser, character, folder, showSaving, t])

  // Gallery
  const fetchGallery = useCallback(() => {
    if (!editingCharacterId) return
    characterGalleryApi.list(editingCharacterId).then((items) => setGalleryItems(items.filter((item) => !isImageDeleted(item.image_id) && !isGalleryItemRemoved(editingCharacterId, item.id)))).catch(() => {})
  }, [editingCharacterId])

  useEffect(() => {
    fetchGallery()
  }, [fetchGallery])

  useEffect(() => onImageDeleted((id) => {
    setGalleryItems((prev) => prev.filter((item) => item.image_id !== id))
  }), [])

  useEffect(() => onGalleryItemRemoved((item) => {
    if (item.characterId === editingCharacterId) setGalleryItems((prev) => prev.filter((entry) => entry.id !== item.id))
  }), [editingCharacterId])

  // Gallery virtualization: the grid can grow very large for image-heavy
  // characters, so render only the viewport rows via TanStack Virtual.
  const galleryColumns = useMemo(() => {
    if (galleryGridWidth <= 0) return 3
    return Math.max(1, Math.floor((galleryGridWidth + GALLERY_GAP) / (GALLERY_MIN_ITEM_WIDTH + GALLERY_GAP)))
  }, [galleryGridWidth])

  const galleryRowCount = useMemo(() => {
    const totalCells = galleryItems.length + 1 // +1 for the add button
    return Math.max(1, Math.ceil(totalCells / galleryColumns))
  }, [galleryItems.length, galleryColumns])

  const galleryItemWidth = useMemo(() => {
    if (galleryGridWidth <= 0) return GALLERY_MIN_ITEM_WIDTH
    return Math.max(1, (galleryGridWidth - GALLERY_GAP * (galleryColumns - 1)) / galleryColumns)
  }, [galleryGridWidth, galleryColumns])

  const galleryRowEstimate = useMemo(() => galleryItemWidth + GALLERY_GAP, [galleryItemWidth])

  const galleryCells = useMemo(() => [
    ...galleryItems.map((item) => ({ id: item.id, item })),
    { id: '__add__', item: null },
  ], [galleryItems])

  const galleryVirtualizer = useVirtualizer({
    count: galleryRowCount,
    getScrollElement: () => galleryScrollRef.current,
    estimateSize: () => galleryRowEstimate,
    overscan: GALLERY_OVERSCAN,
    anchorTo: 'start',
    // Android flings must commit the visible range before the next paint.
    useFlushSync: getTauriMobilePlatform() === 'android',
    getItemKey: (index) => {
      const start = index * galleryColumns
      const end = Math.min(start + galleryColumns, galleryItems.length)
      const keys = galleryItems.slice(start, end).map((item) => item.id)
      if (index === galleryRowCount - 1) keys.push('__add__')
      return keys.join('|') || `row-${index}`
    },
  })

  useEffect(() => {
    if (activeTab !== 'gallery') return
    const el = galleryScrollRef.current
    if (!el) return

    let frame = 0
    const update = () => {
      frame = 0
      setGalleryGridWidth(el.clientWidth)
    }

    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    update()
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    window.addEventListener('resize', schedule)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [activeTab])

  useEffect(() => {
    galleryVirtualizer.measure()
  }, [galleryVirtualizer, galleryColumns, galleryRowEstimate])

  const boundRegexScripts = useMemo(
    () => regexScripts.filter((s) => s.scope === 'character' && s.scope_id === editingCharacterId),
    [regexScripts, editingCharacterId]
  )

  useEffect(() => {
    if (!editingCharacterId) return
    loadRegexScripts().catch(() => {})
  }, [editingCharacterId, loadRegexScripts])

  const upsertWorldBookOption = useCallback((book: { id: string; name: string; folder?: string; metadata?: Record<string, any> }) => {
    const normalized = { id: book.id, name: book.name, folder: book.folder ?? '', metadata: book.metadata ?? {} }
    setWorldBooks((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === book.id)
      if (existingIndex === -1) return [normalized, ...prev]

      const next = [...prev]
      next[existingIndex] = normalized
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadWorldBooks = async () => {
      if (!editingCharacterId) return
      try {
        const res = await worldBooksApi.list({ limit: 1000 })
        if (!cancelled) setWorldBooks(res.data.map((b) => ({ id: b.id, name: b.name, folder: b.folder || '', metadata: b.metadata || {} })))
      } catch {
        // no-op
      }
    }
    loadWorldBooks()
    const offLibraryChanged = wsClient.on(EventType.WORLD_BOOK_LIBRARY_CHANGED, loadWorldBooks)
    return () => {
      cancelled = true
      offLibraryChanged()
    }
  }, [editingCharacterId])

  const handleGalleryUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0 || !editingCharacterId) return
      e.target.value = ''
      setGalleryUploading(true)
      try {
        let items: CharacterGalleryItem[]
        let skipped: { name: string; reason: string }[] = []
        if (files.length === 1) {
          items = [await characterGalleryApi.upload(editingCharacterId, files[0])]
        } else {
          const result = await characterGalleryApi.uploadMany(editingCharacterId, files)
          items = result.items
          skipped = result.skipped
        }
        if (items.length > 0) setGalleryItems((prev) => [...prev, ...items])
        if (skipped.length > 0) {
          const names = skipped.map((s) => s.name).join(', ')
          toast.error(t('characterEditor.gallerySkipped', { count: skipped.length, names }))
        }
      } catch (err: any) {
        toast.error(err?.body?.error || err?.message || t('characterEditor.galleryUploadFailed'))
      } finally {
        setGalleryUploading(false)
      }
    },
    [editingCharacterId, t]
  )

  const handleGalleryRemove = useCallback(
    async (itemId: string) => {
      if (!editingCharacterId || galleryPendingRemovals.current.has(itemId)) return
      galleryPendingRemovals.current.add(itemId)
      setGalleryDeletingIds(new Set(galleryPendingRemovals.current))
      try {
        await characterGalleryApi.remove(editingCharacterId, itemId)
        setGalleryItems((prev) => prev.filter((i) => i.id !== itemId))
      } catch (error: any) {
        toast.error(error?.body?.error || error?.message || 'Gallery removal could not be confirmed')
      } finally {
        galleryPendingRemovals.current.delete(itemId)
        setGalleryDeletingIds(new Set(galleryPendingRemovals.current))
      }
    },
    [editingCharacterId]
  )

  const setGalleryImageAsChatBackground = useCallback(async (item: CharacterGalleryItem) => {
    if (!activeChatId) {
      toast.error(t('characterEditor.openChatForBackground'))
      return
    }
    const wallpaper: WallpaperRef = { image_id: item.image_id, type: 'image' }
    try {
      await chatsApi.patchMetadata(activeChatId, { wallpaper })
      setActiveChatWallpaper(wallpaper)
      setSceneBackground(null)
      setGalleryContextMenu(null)
      toast.success(t('characterEditor.chatBackgroundUpdated'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterEditor.chatBackgroundFailed'))
    }
  }, [activeChatId, setActiveChatWallpaper, setSceneBackground, t])

  const copyGalleryImageReference = useCallback((item: CharacterGalleryItem) => {
    const markdown = galleryImageMarkdown(item, t('characterEditor.galleryImage'))
    setGalleryContextMenu(null)
    void copyTextToClipboard(markdown)
      .then(() => toast.success(t('characterEditor.imageReferenceCopied')))
      .catch(() => toast.error(t('characterEditor.imageReferenceCopyFailed')))
  }, [t])

  const handleGalleryReferenceRename = useCallback(async (name: string) => {
    if (!editingCharacterId || !galleryRenameItem) return
    setGalleryRenaming(true)
    try {
      const updated = await characterGalleryApi.renameReference(
        editingCharacterId,
        galleryRenameItem.id,
        name,
      )
      setGalleryItems((current) => current.map((item) => item.id === updated.id ? updated : item))
      setGalleryRenameItem(null)
      toast.success(t('characterEditor.galleryReferenceRenamed', { reference: updated.reference }))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterEditor.galleryReferenceRenameFailed'))
    } finally {
      setGalleryRenaming(false)
    }
  }, [editingCharacterId, galleryRenameItem, t])

  const galleryContextMenuItems: ContextMenuEntry[] = galleryContextMenu ? [
    {
      key: 'rename-image-reference',
      label: t('characterEditor.renameImageReference'),
      icon: <Pencil size={14} />,
      onClick: () => {
        setGalleryRenameItem(galleryContextMenu.item)
        setGalleryContextMenu(null)
      },
    },
    {
      key: 'copy-image-reference',
      label: t('characterEditor.copyImageReference'),
      icon: <Copy size={14} />,
      onClick: () => copyGalleryImageReference(galleryContextMenu.item),
    },
    {
      key: 'set-chat-background',
      label: t('characterEditor.setAsChatBackground'),
      disabled: !activeChatId,
      onClick: () => setGalleryImageAsChatBackground(galleryContextMenu.item),
    },
  ] : []

  const handleGalleryExtract = useCallback(async () => {
    if (!editingCharacterId) return
    setExtracting(true)
    try {
      const items = await characterGalleryApi.extract(editingCharacterId)
      if (items.length > 0) setGalleryItems((prev) => [...prev, ...items])
    } catch {
      // extraction failed
    } finally {
      setExtracting(false)
    }
  }, [editingCharacterId])

  const embeddedImageCount = useMemo(() => {
    if (!character) return 0
    const texts = [
      character.first_mes,
      character.description,
      character.personality,
      character.scenario,
      character.mes_example,
      character.system_prompt,
      character.post_history_instructions,
      character.creator_notes,
      ...(character.alternate_greetings || []),
      character.extensions ? JSON.stringify(character.extensions) : '',
    ]
    const seen = new Set<string>()
    for (const t of texts) {
      if (!t) continue
      for (const url of extractEmbeddedImageUrls(t)) seen.add(url)
    }
    return seen.size
  }, [character])

  const debouncedSave = useCallback(
    (field: string, value: any) => {
      if (!editingCharacterId) return
      clearTimeout(timers.current[field])
      timers.current[field] = setTimeout(() => {
        showSaving()
        browser.updateCharacter(editingCharacterId, { [field]: value })
      }, DEBOUNCE_MS)
    },
    [editingCharacterId, browser, showSaving]
  )

  // ── Atomic extensions mutation pipeline ──────────────────────────────
  // World book attachments, alternate fields, alternate avatars, extension-
  // owned character-editor tabs, and the raw extensions textarea all write to
  // the same `extensions` blob. Without a single source of truth, an
  // immediate save (e.g. toggling a world book) and a debounced save (e.g.
  // typing in an alt-field variant) can race and clobber each other — the
  // debounced save fires last with stale data and wipes the world book
  // change. The pendingExtensionsRef tracks the latest mutated extensions so
  // every callsite reads from the freshest value, and mutateExtensions
  // cancels any pending debounced extensions save when an immediate save
  // lands so the in-flight changes get persisted together.
  const pendingExtensionsRef = useRef<Record<string, any> | null>(null)

  const workingExtensions = useMemo(() => {
    try {
      const parsed = JSON.parse(extensionsJson)
      if (isRecord(parsed)) return parsed
    } catch {
    }

    return pendingExtensionsRef.current ?? character?.extensions ?? {}
  }, [extensionsJson, character?.extensions])
  const attributionUrl = useMemo(() => readCharacterSourceUrl(workingExtensions), [workingExtensions])
  // Only Chub-sourced cards can be backfilled, so the button hides otherwise.
  const chubSourcePath = useMemo(() => readChubFullPath(workingExtensions), [workingExtensions])

  // This report intentionally uses the editor's local draft state rather than
  // the saved card, so it remains useful while the user is still typing.
  const tokenReportItems = useMemo<CharacterTokenReportItem[]>(() => {
    const baseFields = [
      ['description', t('characterEditor.description')],
      ['personality', t('characterEditor.personality')],
      ['scenario', t('characterEditor.scenario')],
      ['system_prompt', t('characterEditor.systemPrompt')],
      ['post_history_instructions', t('characterEditor.postHistory')],
      ['mes_example', t('characterEditor.messageExamples')],
    ] as const
    const items: CharacterTokenReportItem[] = baseFields.map(([field, label]) => ({
      id: `base:${field}`,
      label,
      text: fields[field] || '',
      group: 'base',
    }))

    const alternateFields = isRecord(workingExtensions.alternate_fields) ? workingExtensions.alternate_fields : {}
    for (const [field, baseLabel] of baseFields.slice(0, 3)) {
      const variants = Array.isArray(alternateFields[field]) ? alternateFields[field] : []
      variants.forEach((variant: unknown, index: number) => {
        if (!isRecord(variant)) return
        const label = typeof variant.label === 'string' && variant.label.trim()
          ? variant.label
          : `${t('characterEditor.alternateField.default')} ${index + 1}`
        items.push({
          id: `variant:${field}:${typeof variant.id === 'string' ? variant.id : index}`,
          label: `${baseLabel} — ${label}`,
          text: typeof variant.content === 'string' ? variant.content : '',
          group: 'variant',
        })
      })
    }

    items.push({
      id: 'greeting:first',
      label: getGreetingTitle(workingExtensions, 0) || t('characterEditor.firstMessage'),
      text: fields.first_mes || '',
      group: 'greeting',
    })
    alternateGreetings.forEach((greeting, index) => {
      items.push({
        id: `greeting:${index}`,
        label: getGreetingTitle(workingExtensions, index + 1)
          || t('characterEditor.greetingNumber', { n: index + 1 }),
        text: greeting,
        group: 'greeting',
      })
    })

    return items
  }, [alternateGreetings, fields, t, workingExtensions])


  const flushExtensionsSave = useCallback(async () => {
    if (!editingCharacterId) return
    clearTimeout(timers.current['extensions'])
    timers.current['extensions'] = undefined as unknown as ReturnType<typeof setTimeout>
    const next = pendingExtensionsRef.current
    if (!next) return
    pendingExtensionsRef.current = null
    showSaving()
    await browser.updateCharacter(editingCharacterId, { extensions: next })
  }, [editingCharacterId, browser, showSaving])

  const mutateExtensions = useCallback(
    (mutator: (ext: Record<string, any>) => Record<string, any>, immediate: boolean) => {
      if (!editingCharacterId || !character) return
      // Read from the pending ref first (latest in-flight state) so successive
      // mutations build on each other instead of racing back to the store.
      const baseline = pendingExtensionsRef.current ?? (character.extensions || {})
      const next = mutator({ ...baseline })
      pendingExtensionsRef.current = next
      setExtensionsJson(JSON.stringify(next, null, 2))
      setJsonError(null)

      if (immediate) {
        void flushExtensionsSave()
      } else {
        clearTimeout(timers.current['extensions'])
        timers.current['extensions'] = setTimeout(() => {
          void flushExtensionsSave()
        }, DEBOUNCE_MS)
      }
    },
    [editingCharacterId, character, flushExtensionsSave]
  )

  const activeTabRef = useRef<TabId>('core')
  const editingCharacterIdRef = useRef<string | null>(editingCharacterId)
  const workingExtensionsRef = useRef<Record<string, any>>(workingExtensions)
  const mutateExtensionsRef = useRef(mutateExtensions)
  const flushExtensionsSaveRef = useRef(flushExtensionsSave)

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    editingCharacterIdRef.current = editingCharacterId
  }, [editingCharacterId])

  useEffect(() => {
    workingExtensionsRef.current = workingExtensions
  }, [workingExtensions])

  useEffect(() => {
    mutateExtensionsRef.current = mutateExtensions
  }, [mutateExtensions])

  useEffect(() => {
    flushExtensionsSaveRef.current = flushExtensionsSave
  }, [flushExtensionsSave])

  useEffect(() => {
    setCharacterEditorController({
      getState: () => ({
        open: Boolean(editingCharacterIdRef.current),
        characterId: editingCharacterIdRef.current,
        activeTabId: editingCharacterIdRef.current ? activeTabRef.current : null,
        extensions: workingExtensionsRef.current,
      }),
      setActiveTab: (tabId) => {
        setActiveTab(tabId)
      },
      updateExtensions: (mutator, immediate) => {
        mutateExtensionsRef.current(mutator, immediate)
      },
      flush: () => flushExtensionsSaveRef.current(),
    })

    return () => {
      setCharacterEditorController(null)
    }
  }, [])

  useEffect(() => {
    syncCharacterEditorState({
      open: isOpen,
      characterId: editingCharacterId ?? null,
      activeTabId: isOpen ? activeTab : null,
      extensions: workingExtensions,
    })
  }, [activeTab, editingCharacterId, isOpen, workingExtensions])

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value)
      if (value.trim()) debouncedSave('name', value.trim())
    },
    [debouncedSave]
  )

  const handleFieldChange = useCallback(
    (field: string, value: string) => {
      setFields((prev) => ({ ...prev, [field]: value }))
      debouncedSave(field, value)
    },
    [debouncedSave]
  )

  const handleAlternatesChange = useCallback(
    (field: AvatarBindingField, variants: Array<{ id: string; label: string; content: string }>) => {
      mutateExtensions((ext) => setAlternateFieldVariants(ext, field, variants), false)
    },
    [mutateExtensions]
  )

  const handleAlternateAvatarsChange = useCallback(
    (avatars: AlternateAvatarEntry[]) => {
      mutateExtensions((ext) => {
        const next = { ...ext }
        if (avatars.length > 0) next.alternate_avatars = avatars
        else delete next.alternate_avatars
        return next
      }, false)
    },
    [mutateExtensions]
  )

  const handleAvatarBindingsChange = useCallback(
    (bindings: AvatarBindings) => {
      mutateExtensions((ext) => {
        const next = { ...ext }
        if (Object.keys(bindings).length > 0) next.avatar_bindings = bindings
        else delete next.avatar_bindings
        return next
      }, false)
    },
    [mutateExtensions]
  )

  const handleAlternateCharacterNameChange = useCallback(
    (value: string) => {
      setAlternateCharacterName(value)
      mutateExtensions((ext) => {
        const next = { ...ext }
        if (value.trim()) next.alternate_character_name = value.trim()
        else delete next.alternate_character_name
        return next
      }, false)
    },
    [mutateExtensions]
  )

  const commitSourceLink = useCallback(() => {
    const value = sourceLinkDraft.trim()
    if (!value) {
      setSourceLinkDraft('')
      setSourceLinkError(null)
      mutateExtensions((ext) => setCharacterSource(ext, null), true)
      return
    }

    const source = parseCharacterSourceInput(value)
    if (!source) {
      setSourceLinkError(t('characterEditor.originalSourceInvalid'))
      return
    }

    setSourceLinkDraft(source.url)
    setSourceLinkError(null)
    mutateExtensions((ext) => setCharacterSource(ext, source), true)
  }, [mutateExtensions, sourceLinkDraft, t])


  const handleAvatarSelect = useCallback(
    async (avatarEntryId: string) => {
      if (!activeChatId || !character) return
      try {
        await flushExtensionsSave()
        const latestCharacter = useStore.getState().characters.find((entry) => entry.id === character.id) || character
        await applyChatAppearance(activeChatId, latestCharacter, { type: 'avatar', avatar_entry_id: avatarEntryId })
      } catch (err) {
        console.error('[Editor] Avatar select failed:', err)
        toast.error(err instanceof Error ? err.message : 'Failed to change avatar')
      }
    },
    [activeChatId, character, flushExtensionsSave]
  )

  const handleAddTag = useCallback((raw: string) => {
    if (!editingCharacterId) return
    const tag = raw.trim()
    if (!tag || tags.includes(tag)) return
    const updated = [...tags, tag]
    setTags(updated)
    showSaving()
    browser.updateCharacter(editingCharacterId, { tags: updated })
  }, [tags, editingCharacterId, browser, showSaving])

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (!editingCharacterId) return
      const updated = tags.filter((t) => t !== tag)
      setTags(updated)
      showSaving()
      browser.updateCharacter(editingCharacterId, { tags: updated })
    },
    [tags, editingCharacterId, browser, showSaving]
  )

  const handleGreetingChange = useCallback(
    (index: number, value: string) => {
      const updated = [...alternateGreetings]
      updated[index] = value
      setAlternateGreetings(updated)
      debouncedSave('alternate_greetings', updated)
    },
    [alternateGreetings, debouncedSave]
  )

  const handleGreetingTitleChange = useCallback(
    (greetingIndex: number, value: string) => {
      mutateExtensions((ext) => setGreetingTitle(ext, greetingIndex, value), false)
    },
    [mutateExtensions]
  )

  const handleGreetingBackgroundChange = useCallback(
    (greetingIndex: number, imageId: string | null) => {
      mutateExtensions((ext) => {
        const next = { ...ext }
        const backgrounds = isRecord(ext.greeting_backgrounds)
          ? { ...ext.greeting_backgrounds }
          : {}
        if (imageId) backgrounds[greetingIndex] = imageId
        else delete backgrounds[greetingIndex]
        if (Object.keys(backgrounds).length > 0) next.greeting_backgrounds = backgrounds
        else delete next.greeting_backgrounds
        return next
      }, false)
      setGreetingBackgroundPickerIndex(null)
    },
    [mutateExtensions]
  )

  const handleAddGreeting = useCallback(() => {
    clearTimeout(timers.current['alternate_greetings'])
    const updated = [...alternateGreetings, '']
    setAlternateGreetings(updated)
    setAlternateGreetingIds((current) => [...current, uuidv7()])
    if (editingCharacterId) {
      showSaving()
      browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
    }
  }, [alternateGreetings, editingCharacterId, browser, showSaving])

  const handleRemoveGreeting = useCallback(
    (index: number) => {
      clearTimeout(timers.current['alternate_greetings'])
      const updated = alternateGreetings.filter((_, i) => i !== index)
      setAlternateGreetings(updated)
      setAlternateGreetingIds((current) => current.filter((_, i) => i !== index))
      setGreetingBackgroundPickerIndex(null)
      const removedGreetingIndex = index + 1
      mutateExtensions((ext) => {
        const nextBindings: AvatarBindings = {}
        for (const [avatarId, rawBinding] of Object.entries(isRecord(ext.avatar_bindings) ? ext.avatar_bindings : {})) {
          if (!isRecord(rawBinding)) continue
          const binding = { ...rawBinding } as AvatarBindings[string]
          if (binding.greeting_index === removedGreetingIndex) delete binding.greeting_index
          else if (typeof binding.greeting_index === 'number' && binding.greeting_index > removedGreetingIndex) {
            binding.greeting_index -= 1
          }
          if (Object.keys(binding).length > 0) nextBindings[avatarId] = binding
        }
        const next = { ...ext }
        if (Object.keys(nextBindings).length > 0) next.avatar_bindings = nextBindings
        else delete next.avatar_bindings
        if (isRecord(ext.greeting_backgrounds)) {
          const backgrounds: Record<number, unknown> = {}
          for (const [rawIndex, imageId] of Object.entries(ext.greeting_backgrounds)) {
            const greetingIndex = Number(rawIndex)
            if (!Number.isInteger(greetingIndex) || greetingIndex === removedGreetingIndex) continue
            backgrounds[greetingIndex > removedGreetingIndex ? greetingIndex - 1 : greetingIndex] = imageId
          }
          if (Object.keys(backgrounds).length > 0) next.greeting_backgrounds = backgrounds
          else delete next.greeting_backgrounds
        }
        return removeAlternateGreetingMetadata(next, index)
      }, false)
      if (editingCharacterId) {
        showSaving()
        browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
      }
    },
    [alternateGreetings, editingCharacterId, browser, mutateExtensions, showSaving]
  )

  const handleGreetingDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = alternateGreetingIds.indexOf(String(active.id))
      const newIndex = alternateGreetingIds.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return

      clearTimeout(timers.current['alternate_greetings'])
      const reorderedGreetings = arrayMove(alternateGreetings, oldIndex, newIndex)
      setAlternateGreetings(reorderedGreetings)
      setAlternateGreetingIds((current) => arrayMove(current, oldIndex, newIndex))
      setGreetingBackgroundPickerIndex(null)

      const oldGreetingIndex = oldIndex + 1
      const newGreetingIndex = newIndex + 1
      mutateExtensions((ext) => {
        let next = moveAlternateGreetingMetadata(ext, oldIndex, newIndex)

        if (isRecord(next.greeting_backgrounds)) {
          const backgrounds: Record<string, unknown> = {}
          for (const [rawIndex, imageId] of Object.entries(next.greeting_backgrounds)) {
            const greetingIndex = Number(rawIndex)
            if (!Number.isInteger(greetingIndex) || greetingIndex < 0) {
              backgrounds[rawIndex] = imageId
              continue
            }
            backgrounds[String(remapGreetingIndexForMove(greetingIndex, oldGreetingIndex, newGreetingIndex))] = imageId
          }
          next = { ...next, greeting_backgrounds: backgrounds }
        }

        if (isRecord(next.avatar_bindings)) {
          const bindings: AvatarBindings = {}
          for (const [avatarId, rawBinding] of Object.entries(next.avatar_bindings)) {
            if (!isRecord(rawBinding)) continue
            const binding = { ...rawBinding } as AvatarBindings[string]
            if (typeof binding.greeting_index === 'number') {
              binding.greeting_index = remapGreetingIndexForMove(
                binding.greeting_index,
                oldGreetingIndex,
                newGreetingIndex,
              )
            }
            bindings[avatarId] = binding
          }
          next = { ...next, avatar_bindings: bindings }
        }

        return next
      }, false)

      if (editingCharacterId) {
        showSaving()
        void browser.updateCharacter(editingCharacterId, { alternate_greetings: reorderedGreetings })
      }
    },
    [alternateGreetingIds, alternateGreetings, browser, editingCharacterId, mutateExtensions, showSaving]
  )

  const handleExtensionsChange = useCallback(
    (value: string) => {
      setExtensionsJson(value)
      try {
        const parsed = JSON.parse(value)
        setJsonError(null)
        // Mirror the textarea edit into the pending ref so other extensions
        // mutations (world books, alt fields) build on the user's manual edits.
        pendingExtensionsRef.current = parsed
        clearTimeout(timers.current['extensions'])
        timers.current['extensions'] = setTimeout(() => {
          void flushExtensionsSave()
        }, DEBOUNCE_MS)
      } catch {
        setJsonError(t('characterEditor.invalidJson'))
      }
    },
    [flushExtensionsSave, t]
  )

  const handleBindRegex = useCallback(
    async (scriptId: string) => {
      if (!editingCharacterId) return
      try {
        await updateRegexScript(scriptId, { scope: 'character', scope_id: editingCharacterId })
      } catch (err: any) {
        toast.error(err.body?.error || err.message || t('characterEditor.bindRegexFailed'))
      }
    },
    [editingCharacterId, updateRegexScript, t]
  )

  const handleUnbindRegex = useCallback(
    async (scriptId: string) => {
      try {
        await updateRegexScript(scriptId, { scope: 'global', scope_id: null })
      } catch (err: any) {
        toast.error(err.body?.error || err.message || t('characterEditor.unbindRegexFailed'))
      }
    },
    [updateRegexScript, t]
  )

  const clearActivatedWorldInfo = useStore((s) => s.clearActivatedWorldInfo)

  const attachedWorldBookIds = useMemo(
    () => getCharacterWorldBookIds(workingExtensions),
    [workingExtensions]
  )

  const embeddedWorldBook = useMemo(() => {
    if (!editingCharacterId) return null
    const attachedIdSet = new Set(attachedWorldBookIds)
    return worldBooks.find((book) =>
      attachedIdSet.has(book.id)
      && book.metadata?.source === 'character'
      && book.metadata?.source_character_id === editingCharacterId,
    ) ?? null
  }, [attachedWorldBookIds, editingCharacterId, worldBooks])

  const handleRemoveWorldBook = useCallback(
    (worldBookId: string) => {
      mutateExtensions((ext) => {
        const currentIds = getCharacterWorldBookIds(ext)
        const nextIds = currentIds.filter((id) => id !== worldBookId)
        if (nextIds.length === 0) clearActivatedWorldInfo()
        return setCharacterWorldBookIds(ext, nextIds)
      }, true)
    },
    [mutateExtensions, clearActivatedWorldInfo]
  )

  const handleWorldBookIdsChange = useCallback(
    async (ids: string[]) => {
      let approvedIds = ids
      if (activeChatId && editingCharacterId === activeCharacterId) {
        const allowedAddedIds = await filterWorldBooksForChatContextAttachment(
          worldBooks.filter((book) => ids.includes(book.id) && !attachedWorldBookIds.includes(book.id)),
        )
        approvedIds = ids.filter((id) => attachedWorldBookIds.includes(id) || allowedAddedIds.includes(id))
      }

      mutateExtensions((ext) => setCharacterWorldBookIds(ext, approvedIds), true)
      if (approvedIds.length === 0) clearActivatedWorldInfo()
    },
    [activeChatId, activeCharacterId, attachedWorldBookIds, clearActivatedWorldInfo, editingCharacterId, mutateExtensions, worldBooks]
  )

  // Avatar
  const handleCropComplete = useCallback(
    async (croppedFile: File, originalFile: File) => {
      if (!editingCharacterId) return
      setAvatarUploadProgress(0)
      try {
        const updated = await charactersApi.uploadAvatar(editingCharacterId, croppedFile, (p) => setAvatarUploadProgress(p), originalFile)
        updateCharInStore(editingCharacterId, updated)
        setAvatarKey((k) => k + 1)
      } catch (err) {
        console.error('[Editor] Avatar upload failed:', err)
      } finally {
        setAvatarUploadProgress(null)
      }
    },
    [editingCharacterId, updateCharInStore]
  )

  const { cropModalProps, openCropFlow } = useImageCropFlow(handleCropComplete)

  // Both local files and gallery selections use the same avatar save path.
  const handleAltAvatarCropComplete = useCallback(
    async (croppedFile: File, originalFile: File | CharacterGalleryItem) => {
      if (!editingCharacterId || !character) return
      setAltAvatarUploadProgress(0)
      try {
        const entry = await uploadAlternateAvatar(croppedFile, originalFile, t('characterEditor.newAvatar'), setAltAvatarUploadProgress)
        if (editingCharacterIdRef.current !== editingCharacterId) return
        mutateExtensions((ext) => {
          const currentAlts = (ext.alternate_avatars || []) as AlternateAvatarEntry[]
          return { ...ext, alternate_avatars: [...currentAlts, entry] }
        }, true)
      } catch (err) {
        console.error('[AltAvatar] Upload failed:', err)
        toast.error(t('characterBrowser.alternateAvatars.uploadFailed'))
      } finally {
        setAltAvatarUploadProgress(null)
      }
    },
    [editingCharacterId, character, mutateExtensions, t]
  )

  const { cropModalProps: altAvatarCropProps, openCropFlow: openAltAvatarCropFlow } =
    useImageCropFlow(handleAltAvatarCropComplete)

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) openCropFlow(file)
      e.target.value = ''
    },
    [openCropFlow]
  )

  const handleAvatarDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (file && file.type.startsWith('image/')) openCropFlow(file)
    },
    [openCropFlow]
  )

  const handleReplaceCard = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file || !editingCharacterId || replacingCard) return

      setReplacingCard(true)
      try {
        const preview = await charactersApi.previewCardUpdate(editingCharacterId, file)
        setPendingCardUpdate({ file, preview })
      } catch (err: any) {
        toast.error(err?.body?.error || err?.message || t('characterEditor.replaceCardFailed'))
      } finally {
        setReplacingCard(false)
      }
    },
    [editingCharacterId, replacingCard, t]
  )

  const handleCardUpdateApplied = useCallback(
    (updated: Character, summary: CardUpdateApplySummary) => {
      if (!editingCharacterId) return
      // An older debounce firing after the update would otherwise restore
      // stale editor values over the newly-merged card.
      for (const timer of Object.values(timers.current)) clearTimeout(timer)
      pendingExtensionsRef.current = null
      if (layersSaveTimerRef.current) clearTimeout(layersSaveTimerRef.current)

      lastSyncedId.current = null
      updateCharInStore(editingCharacterId, updated)
      if (summary.avatarUpdated === 'replace_primary') {
        setAvatarKey((k) => k + 1)
      }
      setPendingCardUpdate(null)
      toast.success(
        t('characterEditor.replaceCardSuccess', {
          name: updated.name,
          count: summary.updatedFields.length,
        }),
      )
    },
    [editingCharacterId, t, updateCharInStore]
  )

  const perspectiveLayers = useMemo<CharacterPerspectiveLayerInput[]>(() => {
    return readPerspectiveLayers(character?.extensions?.landing_perspective_layers)
  }, [character?.extensions?.landing_perspective_layers])

  // Keep the in-editor perspective layer list in sync with the store character
  // when the edited character changes, without clobbering local in-flight edits.
  useEffect(() => {
    if (!character) return
    const nextLayers = clonePerspectiveLayers(perspectiveLayers)
    setLocalPerspectiveLayers(nextLayers)
    pendingLayersRef.current = clonePerspectiveLayers(nextLayers)
    syncedPerspectiveLayersRef.current = clonePerspectiveLayers(nextLayers)
  }, [character?.id, character, perspectiveLayers])

  const flushPerspectiveLayersSave = useCallback(async () => {
    if (!editingCharacterId) return
    // Chain saves so rapid edits never race or overwrite each other.
    const run = async () => {
      layersSaveTimerRef.current = null
      if (skipPerspectiveLayerFlushRef.current) return

      const toSave = clonePerspectiveLayers(pendingLayersRef.current)
      if (arePerspectiveLayersEqual(toSave, syncedPerspectiveLayersRef.current)) return
      if (!useStore.getState().characters.some((entry) => entry.id === editingCharacterId)) return

      try {
        showSaving()
        const updated = await charactersApi.updatePerspectiveLayers(editingCharacterId, toSave)
        const savedLayers = readPerspectiveLayers(updated.extensions?.landing_perspective_layers)
        syncedPerspectiveLayersRef.current = clonePerspectiveLayers(savedLayers)
        // Only adopt the server response if local state hasn't moved on since the save started.
        if (arePerspectiveLayersEqual(pendingLayersRef.current, toSave)) {
          updateCharInStore(editingCharacterId, updated)
        }
      } catch (err) {
        console.error('[Editor] Perspective layer save failed:', err)
        toast.error('Could not save perspective layers')
      }
    }
    layerSaveLockRef.current = (layerSaveLockRef.current ?? Promise.resolve()).then(run, run)
    await layerSaveLockRef.current
  }, [editingCharacterId, updateCharInStore, showSaving])

  const requestPerspectiveLayersSave = useCallback(() => {
    if (layersSaveTimerRef.current) clearTimeout(layersSaveTimerRef.current)
    layersSaveTimerRef.current = setTimeout(() => {
      void flushPerspectiveLayersSave()
    }, 400)
  }, [flushPerspectiveLayersSave])

  // Flush any pending layer edits when the editor closes or the character changes.
  useEffect(() => () => {
    if (layersSaveTimerRef.current) clearTimeout(layersSaveTimerRef.current)
    if (skipPerspectiveLayerFlushRef.current) {
      skipPerspectiveLayerFlushRef.current = false
      return
    }
    void flushPerspectiveLayersSave()
  }, [flushPerspectiveLayersSave])

  const handlePerspectiveLayerSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file || !editingCharacterId) return
      if (localPerspectiveLayers.length >= MAX_PERSPECTIVE_LAYERS) {
        toast.error(`Maximum ${MAX_PERSPECTIVE_LAYERS} landing layers`)
        return
      }
      // Persist any pending layer edits before uploading so the new layer is appended to the latest stack.
      if (layersSaveTimerRef.current) clearTimeout(layersSaveTimerRef.current)
      await flushPerspectiveLayersSave()
      setPerspectiveLayerProgress(0)
      try {
        const updated = await charactersApi.addPerspectiveLayer(
          editingCharacterId,
          file,
          { label: `Layer ${localPerspectiveLayers.length + 1}`, intensity: localPerspectiveLayers.length === 0 ? 0.2 : 0.7 },
          setPerspectiveLayerProgress,
        )
        const next = readPerspectiveLayers(updated.extensions?.landing_perspective_layers)
        setLocalPerspectiveLayers(next)
        pendingLayersRef.current = clonePerspectiveLayers(next)
        syncedPerspectiveLayersRef.current = clonePerspectiveLayers(next)
        updateCharInStore(editingCharacterId, updated)
      } catch (err) {
        console.error('[Editor] Perspective layer upload failed:', err)
        toast.error(err instanceof Error ? err.message : 'Perspective layer upload failed')
      } finally {
        setPerspectiveLayerProgress(null)
      }
    },
    [editingCharacterId, localPerspectiveLayers.length, updateCharInStore, flushPerspectiveLayersSave]
  )

  const handleRemovePerspectiveLayer = useCallback(
    (layerId: string) => {
      const next = localPerspectiveLayers.filter((layer) => layer.id !== layerId)
      setLocalPerspectiveLayers(next)
      pendingLayersRef.current = next
      requestPerspectiveLayersSave()
    },
    [localPerspectiveLayers, requestPerspectiveLayersSave]
  )

  const handlePerspectiveLayerDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = localPerspectiveLayers.findIndex((layer) => layer.id === active.id)
      const newIndex = localPerspectiveLayers.findIndex((layer) => layer.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      const next = arrayMove(localPerspectiveLayers, oldIndex, newIndex)
      setLocalPerspectiveLayers(next)
      pendingLayersRef.current = next
      requestPerspectiveLayersSave()
    },
    [localPerspectiveLayers, requestPerspectiveLayersSave]
  )

  const handlePerspectiveLayerLabelChange = useCallback(
    (layerId: string, label: string) => {
      const next = localPerspectiveLayers.map((layer) => layer.id === layerId ? { ...layer, label } : layer)
      setLocalPerspectiveLayers(next)
      pendingLayersRef.current = next
      requestPerspectiveLayersSave()
    },
    [localPerspectiveLayers, requestPerspectiveLayersSave]
  )

  const handlePerspectiveLayerIntensityChange = useCallback(
    (layerId: string, intensity: number) => {
      const next = localPerspectiveLayers.map((layer) => layer.id === layerId ? { ...layer, intensity } : layer)
      setLocalPerspectiveLayers(next)
      pendingLayersRef.current = next
      requestPerspectiveLayersSave()
    },
    [localPerspectiveLayers, requestPerspectiveLayersSave]
  )

  // Actions
  const handleDelete = useCallback(async () => {
    if (!editingCharacterId) return
    skipPerspectiveLayerFlushRef.current = true
    try {
      await browser.deleteCharacter(editingCharacterId)
      close()
      setShowDeleteConfirm(false)
    } catch (err) {
      skipPerspectiveLayerFlushRef.current = false
      throw err
    }
  }, [editingCharacterId, browser, close])

  const handleDuplicate = useCallback(async () => {
    if (!editingCharacterId) return
    const dup = await browser.duplicateCharacter(editingCharacterId)
    setEditingCharacterId(dup.id)
  }, [editingCharacterId, browser, setEditingCharacterId])

  const handleOpenChat = useCallback(() => {
    if (!character) return
    close()
    browser.openChat(character)
  }, [character, browser, close])

  const handleCreatePersonaFromCharacter = useCallback(async () => {
    if (!character || creatingPersona) return

    const description = (fields.description || '').trim()
    const personality = (fields.personality || '').trim()
    const personaDescription = [description, personality].filter(Boolean).join('\n\n')
    if (!personaDescription) {
      toast.error(t('characterEditor.personaCreateNoContent'))
      return
    }

    setCreatingPersona(true)
    try {
      let persona = await personasApi.create({
        name: (name || character.name).trim() || character.name,
        description: personaDescription,
      })
      addPersona(persona)
      if (character.image_id || character.avatar_path) {
        try {
          const avatarBlob = await charactersApi.getAvatarBlob(character.id)
          const avatarFile = new File([avatarBlob], `avatar.${avatarExtension(avatarBlob.type)}`, {
            type: avatarBlob.type || 'image/png',
          })
          const originalImageId = typeof character.extensions?.original_image_id === 'string'
            ? character.extensions.original_image_id
            : character.image_id
          let originalFile: File | undefined
          if (originalImageId) {
            const originalRes = await fetch(imagesApi.url(originalImageId), { credentials: 'include' })
            if (originalRes.ok) {
              const originalBlob = await originalRes.blob()
              originalFile = new File(
                [originalBlob],
                `avatar-original.${avatarExtension(originalBlob.type)}`,
                { type: originalBlob.type || 'image/png' },
              )
            }
          }
          persona = await personasApi.uploadAvatar(persona.id, avatarFile, originalFile)
          updatePersona(persona.id, persona)
        } catch {
          toast.warning(t('characterEditor.personaAvatarCopyFailed'))
        }
      }
      setSelectedPersonaId(persona.id)
      toast.success(t('characterEditor.personaCreateSuccess', { name: persona.name }))
      close()
      openDrawer('personas')
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterEditor.personaCreateFailed'))
    } finally {
      setCreatingPersona(false)
    }
  }, [addPersona, character, close, creatingPersona, fields.description, fields.personality, name, openDrawer, setSelectedPersonaId, t, updatePersona])

  const [showExportMenu, setShowExportMenu] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [headerActionMenuPosition, setHeaderActionMenuPosition] = useState<ContextMenuPos | null>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const activeCharxExportRef = useRef<{
    exportId: string
    characterId: string
    characterName: string
    toastId: string
    awaitsNativeSave: boolean
  } | null>(null)

  useEffect(() => {
    return wsClient.on(EventType.CHARACTER_EXPORT_PROGRESS, (payload: CharxExportProgress) => {
      const active = activeCharxExportRef.current
      if (!active || payload.exportId !== active.exportId || payload.characterId !== active.characterId) return

      if (payload.phase === 'collecting_assets') {
        toast.update(active.toastId, {
          message: t('characterEditor.exportAssetsProgress', {
            completed: payload.completed ?? 0,
            total: payload.total ?? 0,
          }),
        })
        return
      }
      if (payload.phase === 'compressing') {
        toast.update(active.toastId, { message: t('characterEditor.exportCompressing') })
        return
      }
      if (payload.phase === 'complete') {
        if (active.awaitsNativeSave) return
        toast.dismiss(active.toastId)
        activeCharxExportRef.current = null
        setExporting(false)
        toast.success(t('characterEditor.exportSuccess', { name: active.characterName, format: 'CHARX' }))
        return
      }
      if (payload.phase === 'failed') {
        toast.dismiss(active.toastId)
        activeCharxExportRef.current = null
        setExporting(false)
        toast.error(t('characterEditor.exportFailed', { error: payload.error || t('characterEditor.unknownError') }))
      }
    })
  }, [t])

  const handleExport = useCallback(async (format: 'json' | 'png' | 'charx') => {
    if (!editingCharacterId || !character) return
    setExporting(true)
    setShowExportMenu(false)
    const formatLabel = format === 'charx' ? 'CHARX' : format === 'png' ? 'PNG' : 'JSON'
    const toastId = toast.info(t('characterEditor.preparingExport', { format: formatLabel }), {
      title: t('characterEditor.exporting'),
      duration: format === 'charx' ? 0 : 60_000,
      dismissible: false,
    })

    if (format === 'charx') {
      const exportId = uuidv7()
      activeCharxExportRef.current = {
        exportId,
        characterId: editingCharacterId,
        characterName: character.name,
        toastId,
        awaitsNativeSave: hasNativeDownloadCompletion(),
      }
      try {
        await charactersApi.downloadCharxExport(editingCharacterId, exportId, character.name)
        if (activeCharxExportRef.current?.exportId === exportId && activeCharxExportRef.current.awaitsNativeSave) {
          activeCharxExportRef.current = null
          setExporting(false)
          toast.dismiss(toastId)
          toast.success(t('characterEditor.exportSuccess', { name: character.name, format: 'CHARX' }))
        }
      } catch (err) {
        if (activeCharxExportRef.current?.exportId !== exportId) return
        activeCharxExportRef.current = null
        setExporting(false)
        toast.dismiss(toastId)
        toast.error(t('characterEditor.exportFailed', { error: err instanceof Error ? err.message : t('characterEditor.unknownError') }))
      }
      return
    }

    try {
      await charactersApi.exportCharacter(editingCharacterId, format, character.name)
      toast.dismiss(toastId)
      toast.success(t('characterEditor.exportSuccess', { name: character.name, format: formatLabel }))
    } catch (err) {
      console.error('[Export] Failed:', err)
      toast.dismiss(toastId)
      toast.error(t('characterEditor.exportFailed', { error: err instanceof Error ? err.message : t('characterEditor.unknownError') }))
    } finally {
      setExporting(false)
    }
  }, [editingCharacterId, character, t])

  const headerActionMenuItems: ContextMenuEntry[] = [
    {
      key: 'token-report',
      label: t('characterEditor.tokenReportTitle'),
      icon: <Hash size={14} />,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        setShowTokenReport(true)
      },
    },
    {
      key: 'create-persona',
      label: t('characterEditor.createPersona'),
      icon: creatingPersona ? <Spinner size={14} fast /> : <UserPlus size={14} />,
      disabled: creatingPersona,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        void handleCreatePersonaFromCharacter()
      },
    },
    {
      key: 'replace-card',
      label: t('characterEditor.replaceCard'),
      icon: replacingCard ? <Spinner size={14} fast /> : <Upload size={14} />,
      disabled: replacingCard,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        cardReplaceFileRef.current?.click()
      },
    },
    { key: 'export-divider', type: 'divider' },
    {
      key: 'export-json',
      label: t('characterEditor.exportJson'),
      icon: <Download size={14} />,
      disabled: exporting,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        void handleExport('json')
      },
    },
    {
      key: 'export-png',
      label: t('characterEditor.exportPng'),
      icon: <Download size={14} />,
      disabled: exporting,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        void handleExport('png')
      },
    },
    {
      key: 'export-charx',
      label: t('characterEditor.exportCharx'),
      icon: <Download size={14} />,
      disabled: exporting,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        void handleExport('charx')
      },
    },
    { key: 'duplicate-divider', type: 'divider' },
    {
      key: 'duplicate',
      label: t('characterEditor.duplicate'),
      icon: <Copy size={14} />,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        void handleDuplicate()
      },
    },
    {
      key: 'delete',
      label: tc('actions.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => {
        setHeaderActionMenuPosition(null)
        setShowDeleteConfirm(true)
      },
    },
  ]

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showExportMenu])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  const handleBackdropMouseDown = useCallback(
    (e: React.MouseEvent) => { mouseDownTargetRef.current = e.target },
    []
  )

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) close()
    },
    [close]
  )

  const activeExtensionTab = characterEditorTabs.find((tab) => tab.id === activeTab) ?? null

  return createPortal(
    <>
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={handleBackdropMouseDown}
          onClick={handleBackdropClick}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            {!character ? (
              <div className={styles.header}>
                <span className={styles.creatorText}>
                  {characterLoadError?.id === editingCharacterId ? characterLoadError.message : tc('actions.loading')}
                </span>
                <CloseButton onClick={close} variant="solid" />
              </div>
            ) : (
              <>
                {/* Header */}
                <div className={styles.header}>
                  <div
                    className={styles.avatarZone}
                    onClick={() => { if (avatarUploadProgress === null) fileRef.current?.click() }}
                    onDrop={handleAvatarDrop}
                    onDragOver={(e) => e.preventDefault()}
                    title={t('characterEditor.changeAvatar')}
                  >
                    <LazyImage
                      key={avatarKey}
                      src={getCharacterAvatarThumbUrl(character) ?? ''}
                      alt={character.name}
                      className={styles.avatarImg}
                      fallback={
                        <div className={styles.avatarFallback}>
                          <User size={20} />
                        </div>
                      }
                    />
                    <div className={clsx(styles.avatarOverlay, avatarUploadProgress !== null && styles.avatarOverlayUploading)}>
                      {avatarUploadProgress !== null ? (
                        <span className={styles.avatarProgressText}>{avatarUploadProgress}%</span>
                      ) : (
                        <Upload size={14} />
                      )}
                    </div>
                  </div>

                  {/* Keep these inputs outside the clickable avatar zone. A
                      programmatic click on the card input bubbles; nesting it
                      above would also trigger the avatar's image-only picker. */}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className={styles.hiddenInput}
                    onChange={handleFileSelected}
                  />
                  <input
                    ref={cardReplaceFileRef}
                    type="file"
                    accept=".json,application/json,.png,image/png,.charx,.jpg,.jpeg"
                    className={styles.hiddenInput}
                    onChange={handleReplaceCard}
                  />

                  <div className={styles.headerInfo}>
                    <input
                      type="text"
                      className={styles.nameInput}
                      value={name}
                      onChange={(e) => handleNameChange(e.target.value)}
                      placeholder={t('characterEditor.characterName')}
                    />
                    {character.creator && <span className={styles.creatorText}>{t('characterEditor.byCreator', { name: character.creator })}</span>}
                  </div>

                  {saving && <span className={styles.savingIndicator}>{t('characterEditor.saving')}</span>}

                  <div className={styles.headerActions}>
                    <Button
                      className={styles.desktopHeaderAction}
                      size="icon"
                      variant="ghost"
                      onClick={() => setShowTokenReport(true)}
                      title={t('characterEditor.tokenReportTitle')}
                    >
                      <Hash size={14} />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={handleOpenChat} title={t('characterEditor.openChat')}>
                      <MessageSquare size={14} />
                    </Button>
                    <Button
                      className={styles.desktopHeaderAction}
                      size="icon"
                      variant="ghost"
                      onClick={handleCreatePersonaFromCharacter}
                      title={t('characterEditor.createPersona')}
                      disabled={creatingPersona}
                    >
                      {creatingPersona
                        ? <Spinner size={14} fast />
                        : <UserPlus size={14} />}
                    </Button>
                    <Button
                      className={styles.desktopHeaderAction}
                      size="icon"
                      variant="ghost"
                      onClick={() => cardReplaceFileRef.current?.click()}
                      title={t('characterEditor.replaceCard')}
                      disabled={replacingCard}
                    >
                      {replacingCard ? <Spinner size={14} fast /> : <Upload size={14} />}
                    </Button>
                    <div className={clsx(styles.exportWrapper, styles.desktopHeaderAction)} ref={exportMenuRef}>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => !exporting && setShowExportMenu((v) => !v)}
                        title={tc('actions.export')}
                        disabled={exporting}
                      >
                        {exporting
                          ? <Spinner size={14} fast />
                          : <Download size={14} />}
                      </Button>
                      {showExportMenu && (
                        <div className={styles.exportDropdown}>
                          <button onClick={() => handleExport('json')}>{t('characterEditor.exportJson')}</button>
                          <button onClick={() => handleExport('png')}>{t('characterEditor.exportPng')}</button>
                          <button onClick={() => handleExport('charx')}>{t('characterEditor.exportCharx')}</button>
                        </div>
                      )}
                    </div>
                    <Button className={styles.desktopHeaderAction} size="icon" variant="ghost" onClick={handleDuplicate} title={t('characterEditor.duplicate')}>
                      <Copy size={14} />
                    </Button>
                    <Button
                      className={styles.desktopHeaderAction}
                      size="icon"
                      variant="danger-ghost"
                      onClick={() => setShowDeleteConfirm(true)}
                      title={tc('actions.delete')}
                    >
                      <Trash2 size={14} />
                    </Button>
                    <Button
                      className={styles.mobileActionMenu}
                      size="icon"
                      variant="ghost"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setHeaderActionMenuPosition((position) => position ? null : { x: rect.right, y: rect.bottom + 4 })
                      }}
                      title={t('characterEditor.moreActions')}
                      aria-label={t('characterEditor.moreActions')}
                      aria-expanded={headerActionMenuPosition !== null}
                    >
                      <MoreHorizontal size={16} />
                    </Button>
                  </div>

                  <CloseButton onClick={close} variant="solid" />
                </div>

                {/* Tab bar */}
                <div className={styles.tabBar}>
                  {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={clsx(
                    styles.tab,
                      activeTab === tab.id && styles.tabActive,
                  )}
                    onClick={() => setActiveTab(tab.id)}
                >
                 {tab.label}
                </button>
               ))}
                <span data-spindle-mount="character_editor_tab" data-spindle-scope={`character-editor:${editingCharacterId ?? 'none'}:tab`} style={{ display: 'contents' }} />
              </div>

                {/* Tab content */}
                <div className={styles.tabContent}>
                  {activeTab === 'core' && (
                    <>
                      <AlternateFieldEditor
                        label={t('characterEditor.description')}
                        helper={t('characterEditor.descriptionHelper')}
                        value={fields.description || ''}
                        alternates={workingExtensions.alternate_fields?.description}
                        onChange={(v) => handleFieldChange('description', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('description', variants)}
                        rows={5}
                      />
                      <AlternateFieldEditor
                        label={t('characterEditor.personality')}
                        helper={t('characterEditor.personalityHelper')}
                        value={fields.personality || ''}
                        alternates={workingExtensions.alternate_fields?.personality}
                        onChange={(v) => handleFieldChange('personality', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('personality', variants)}
                        rows={4}
                      />
                      <AlternateFieldEditor
                        label={t('characterEditor.scenario')}
                        helper={t('characterEditor.scenarioHelper')}
                        value={fields.scenario || ''}
                        alternates={workingExtensions.alternate_fields?.scenario}
                        onChange={(v) => handleFieldChange('scenario', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('scenario', variants)}
                        rows={3}
                      />
                    </>
                  )}

                  {activeTab === 'system' && (
                    <>
                      <Field
                        label={t('characterEditor.systemPrompt')}
                        helper={t('characterEditor.systemPromptHelper')}
                        value={fields.system_prompt || ''}
                        onChange={(v) => handleFieldChange('system_prompt', v)}
                        rows={6}
                        showTokenCount
                      />
                      <Field
                        label={t('characterEditor.postHistory')}
                        helper={t('characterEditor.postHistoryHelper')}
                        value={fields.post_history_instructions || ''}
                        onChange={(v) => handleFieldChange('post_history_instructions', v)}
                        rows={4}
                        showTokenCount
                      />
                    </>
                  )}

                  {activeTab === 'greetings' && (
                    <>
                      <div className={styles.greetingMetaRow}>
                        <label className={styles.greetingNameField}>
                          <span>{t('characterEditor.greetingName')}</span>
                          <GreetingNameInput
                            value={getGreetingTitle(workingExtensions, 0) || ''}
                            resetKey={`${character.id}:default`}
                            onChange={(value) => handleGreetingTitleChange(0, value)}
                            placeholder={t('characterEditor.greetingNamePlaceholder')}
                          />
                        </label>
                        <GreetingBackgroundControl
                          greetingIndex={0}
                          imageId={readGreetingBackground(workingExtensions, 0)}
                          galleryItems={galleryItems}
                          open={greetingBackgroundPickerIndex === 0}
                          onToggle={() => setGreetingBackgroundPickerIndex((current) => current === 0 ? null : 0)}
                          onSelect={handleGreetingBackgroundChange}
                          labels={{
                            set: t('characterEditor.setGreetingBackground'),
                            clear: t('characterEditor.clearGreetingBackground'),
                            empty: t('characterEditor.noGalleryImages'),
                          }}
                        />
                      </div>
                      <Field
                        label={t('characterEditor.firstMessage')}
                        helper={t('characterEditor.firstMessageHelper')}
                        value={fields.first_mes || ''}
                        onChange={(v) => handleFieldChange('first_mes', v)}
                        rows={5}
                        showTokenCount
                      />
                      <Field
                        label={t('characterEditor.messageExamples')}
                        helper={t('characterEditor.messageExamplesHelper')}
                        value={fields.mes_example || ''}
                        onChange={(v) => handleFieldChange('mes_example', v)}
                        rows={5}
                        showTokenCount
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.alternateGreetings')}</span>
                        <span className={styles.fieldHelper}>
                          {t('characterEditor.alternateGreetingsHelper')}
                        </span>
                        <DndContext
                          sensors={perspectiveLayerSensors}
                          collisionDetection={closestCenter}
                          onDragEnd={handleGreetingDragEnd}
                        >
                          <SortableContext
                            items={alternateGreetings.map((_, index) => alternateGreetingIds[index] ?? `greeting-${index}`)}
                            strategy={verticalListSortingStrategy}
                          >
                            <div className={styles.greetingList}>
                              {alternateGreetings.map((greeting, i) => {
                                const greetingId = alternateGreetingIds[i] ?? `greeting-${i}`
                                return (
                                  <SortableGreetingItem
                                    key={greetingId}
                                    id={greetingId}
                                    disabled={alternateGreetings.length < 2}
                                  >
                            <div className={styles.greetingHeader}>
                              <span className={styles.greetingLabel}>{t('characterEditor.greetingNumber', { n: i + 1 })}</span>
                              <div className={styles.greetingActions}>
                                <TokenCountButton text={greeting} />
                                <GreetingBackgroundControl
                                  greetingIndex={i + 1}
                                  imageId={readGreetingBackground(workingExtensions, i + 1)}
                                  galleryItems={galleryItems}
                                  open={greetingBackgroundPickerIndex === i + 1}
                                  onToggle={() => setGreetingBackgroundPickerIndex((current) => current === i + 1 ? null : i + 1)}
                                  onSelect={handleGreetingBackgroundChange}
                                  labels={{
                                    set: t('characterEditor.setGreetingBackground'),
                                    clear: t('characterEditor.clearGreetingBackground'),
                                    empty: t('characterEditor.noGalleryImages'),
                                  }}
                                />
                                <button
                                  type="button"
                                  className={styles.removeBtn}
                                  onClick={() => handleRemoveGreeting(i)}
                                  title={t('characterEditor.remove')}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            </div>
                            <GreetingNameInput
                              value={getGreetingTitle(workingExtensions, i + 1) || ''}
                              resetKey={`${character.id}:${greetingId}`}
                              onChange={(value) => handleGreetingTitleChange(i + 1, value)}
                              placeholder={t('characterEditor.greetingNamePlaceholder')}
                              ariaLabel={t('characterEditor.greetingNameFor', { number: i + 1 })}
                            />
                            <ExpandableTextarea
                              className={styles.fieldTextarea}
                              value={greeting}
                              onChange={(v) => handleGreetingChange(i, v)}
                              rows={3}
                              title={t('characterEditor.greetingNumber', { n: i + 1 })}
                              placeholder={t('characterEditor.alternateGreetingPlaceholder')}
                            />
                                  </SortableGreetingItem>
                                )
                              })}
                            </div>
                          </SortableContext>
                        </DndContext>
                        <button type="button" className={styles.addBtn} onClick={handleAddGreeting}>
                          <Plus size={12} /> {t('characterEditor.addGreeting')}
                        </button>
                      </div>
                    </>
                  )}

                  {activeTab === 'identity' && (
                    <>
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.folder')}</span>
                        <span className={styles.fieldHelper}>{t('characterEditor.folderHelper')}</span>
                        <FolderDropdown
                          folders={characterFolders}
                          selectedFolder={folder}
                          onSelect={(value) => void handleFolderChange(value)}
                          onCreateFolder={createCharacterFolder}
                        />
                      </div>
                      <Field
                        label={t('characterEditor.alternateName')}
                        helper={t('characterEditor.alternateNameHelper')}
                        value={alternateCharacterName}
                        onChange={handleAlternateCharacterNameChange}
                        multiline={false}
                      />
                      <Field
                        label={t('characterEditor.creator')}
                        helper={t('characterEditor.creatorHelper')}
                        value={fields.creator || ''}
                        onChange={(v) => handleFieldChange('creator', v)}
                        multiline={false}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.originalSource')}</span>
                        <span className={styles.fieldHelper}>{t('characterEditor.originalSourceHelper')}</span>
                        <div className={styles.creatorSourceRow}>
                          <input
                            type="text"
                            inputMode="url"
                            className={styles.fieldInput}
                            value={sourceLinkDraft}
                            onChange={(event) => {
                              setSourceLinkDraft(event.target.value)
                              setSourceLinkError(null)
                            }}
                            onBlur={commitSourceLink}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                event.currentTarget.blur()
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                setSourceLinkDraft(attributionUrl || '')
                                setSourceLinkError(null)
                              }
                            }}
                            placeholder={t('characterEditor.originalSourcePlaceholder')}
                            aria-invalid={sourceLinkError ? true : undefined}
                          />
                          {attributionUrl && (
                          <a
                            href={attributionUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.creatorSourceLink}
                            title={t('characterEditor.openOriginalSource')}
                            aria-label={t('characterEditor.openOriginalSource')}
                          >
                            <ExternalLink size={14} />
                          </a>
                          )}
                        </div>
                        {sourceLinkError && <span className={styles.creatorSourceError}>{sourceLinkError}</span>}
                      </div>
                      <Field
                        label={t('characterEditor.creatorNotes')}
                        helper={t('characterEditor.creatorNotesHelper')}
                        value={fields.creator_notes || ''}
                        onChange={(v) => handleFieldChange('creator_notes', v)}
                        rows={4}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Landing perspective stack</span>
                        <span className={styles.fieldHelper}>
                          Add up to five WebP-optimized layers. Drag to reorder from back to front; each layer controls its own parallax strength on landing-page cards only.
                        </span>
                        <div className={styles.perspectiveStackEditor}>
                          {localPerspectiveLayers.length > 0 ? (
                            <DndContext sensors={perspectiveLayerSensors} collisionDetection={closestCenter} onDragEnd={handlePerspectiveLayerDragEnd}>
                              <SortableContext items={localPerspectiveLayers.map((layer) => layer.id)} strategy={verticalListSortingStrategy}>
                                <div className={styles.perspectiveLayerList}>
                                  {localPerspectiveLayers.map((layer, index) => (
                                    <SortablePerspectiveLayer
                                      key={layer.id}
                                      layer={layer}
                                      index={index}
                                      disabled={localPerspectiveLayers.length < 2}
                                      onLabelChange={handlePerspectiveLayerLabelChange}
                                      onIntensityChange={handlePerspectiveLayerIntensityChange}
                                      onRemove={handleRemovePerspectiveLayer}
                                    />
                                  ))}
                                </div>
                              </SortableContext>
                            </DndContext>
                          ) : (
                            <div className={styles.perspectiveLayerEmptyState}>
                              <ImagePlus size={18} />
                              <span>No landing layers yet.</span>
                            </div>
                          )}

                          <button
                            type="button"
                            className={styles.perspectiveLayerAdd}
                            disabled={localPerspectiveLayers.length >= MAX_PERSPECTIVE_LAYERS || perspectiveLayerProgress !== null}
                            onClick={() => perspectiveLayerFileRef.current?.click()}
                          >
                            {perspectiveLayerProgress !== null ? (
                              <span>{perspectiveLayerProgress}%</span>
                            ) : (
                              <>
                                <Upload size={13} />
                                Add layer ({localPerspectiveLayers.length}/{MAX_PERSPECTIVE_LAYERS})
                              </>
                            )}
                          </button>
                          <input
                            ref={perspectiveLayerFileRef}
                            type="file"
                            accept="image/*"
                            className={styles.hiddenInput}
                            onChange={handlePerspectiveLayerSelected}
                          />
                        </div>
                      </div>
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.tags')}</span>
                        <span className={styles.fieldHelper}>{t('characterEditor.tagsHelper')}</span>
                        <div className={styles.tagsList}>
                          {tags.map((tag) => (
                            <span key={tag} className={styles.tag}>
                              {tag}
                              <button
                                type="button"
                                className={styles.tagRemove}
                                onClick={() => handleRemoveTag(tag)}
                              >
                                <X size={10} />
                              </button>
                            </span>
                          ))}
                          <CharacterTagInput
                            key={editingCharacterId}
                            allTags={browser.allTags}
                            tags={tags}
                            onAdd={handleAddTag}
                            placeholder={t('characterEditor.addTag')}
                          />
                        </div>
                      </div>
                      <AlternateAvatarManager
                        key={editingCharacterId}
                        characterId={editingCharacterId!}
                        primaryImageId={character?.image_id || null}
                        alternates={(workingExtensions.alternate_avatars || []) as AlternateAvatarEntry[]}
                        onChange={handleAlternateAvatarsChange}
                        bindings={(workingExtensions.avatar_bindings || {}) as AvatarBindings}
                        alternateFields={(workingExtensions.alternate_fields || {}) as Record<string, Array<{ id: string; label: string; content: string }>>}
                        greetingCount={1 + alternateGreetings.length}
                        onBindingsChange={handleAvatarBindingsChange}
                        openCropFlow={openAltAvatarCropFlow}
                        onGalleryCropComplete={handleAltAvatarCropComplete}
                        activeChatAvatarId={activeChatId ? activeChatAvatarId : undefined}
                        onAvatarSelect={activeChatId ? handleAvatarSelect : undefined}
                        uploadProgress={altAvatarUploadProgress}
                      />
                    </>
                  )}

                  {activeTab === 'gallery' && (
                    <div className={styles.galleryTab}>
                      <div className={styles.galleryHeader}>
                        <span className={styles.fieldLabel}>{t('characterEditor.imageGallery')}</span>
                        <span className={styles.fieldHelper}>
                          {t('characterEditor.imageGalleryHelper')}
                        </span>
                      </div>

                      <div className={styles.galleryScrollArea} ref={galleryScrollRef}>
                        <div
                          className={styles.galleryVirtualContainer}
                          style={{ height: galleryVirtualizer.getTotalSize() }}
                        >
                          <VirtualGrid
                            items={galleryCells}
                            rows={galleryVirtualizer.getVirtualItems()}
                            columns={galleryColumns}
                            gap={GALLERY_GAP}
                            className={styles.galleryGridRow}
                            measureElement={galleryVirtualizer.measureElement}
                            getItemKey={(cell) => cell.id}
                            renderItem={({ item }) => item ? (
                              <GalleryGridItem
                                item={item}
                                onRemove={handleGalleryRemove}
                                deleting={galleryDeletingIds.has(item.id)}
                                onOpenMenu={(menuItem, pos) => setGalleryContextMenu({ item: menuItem, pos })}
                                onPreview={(previewItem) => setGalleryLightboxSrc(characterGalleryApi.imageUrl(previewItem.image_id))}
                              />
                            ) : (
                              <button
                                type="button"
                                className={styles.galleryAddBtn}
                                onClick={() => galleryFileRef.current?.click()}
                                disabled={galleryUploading}
                              >
                                <ImagePlus size={20} />
                                <span>{galleryUploading ? t('characterEditor.uploading') : t('characterEditor.addImages')}</span>
                              </button>
                            )}
                          />
                        </div>
                      </div>

                      <input
                        ref={galleryFileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className={styles.hiddenInput}
                        onChange={handleGalleryUpload}
                      />

                      {embeddedImageCount > 0 && (
                        <div className={styles.galleryExtract}>
                          <Download size={14} />
                          <div className={styles.galleryExtractInfo}>
                            <span className={styles.fieldLabel}>{t('characterEditor.embeddedImages')}</span>
                            <span className={styles.fieldHelper}>
                              {t('characterEditor.embeddedImagesFound', { count: embeddedImageCount })}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.addBtn}
                            disabled={extracting}
                            onClick={handleGalleryExtract}
                          >
                            {extracting ? t('characterEditor.importing') : t('characterEditor.importAll')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'expressions' && character && (
                    <ExpressionEditorTab characterId={character.id} chubSourcePath={chubSourcePath} />
                  )}

                  {activeTab === 'voice' && (
                    <CharacterVoiceTab
                      value={readVoiceRef(workingExtensions.ttsVoice)}
                      onChange={(next) => {
                        mutateExtensions((ext) => {
                          const out = { ...ext }
                          if (next) out.ttsVoice = next
                          else delete out.ttsVoice
                          return out
                        }, true)
                      }}
                    />
                  )}

                  {activeTab === 'imageLora' && character && (
                    <CharacterLoraTab characterId={character.id} />
                  )}

                  {activeTab === 'advanced' && (
                    <>
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.attachedWorldBooks')}</span>
                        <span className={styles.fieldHelper}>{t('characterEditor.attachedWorldBooksHelper')}</span>
                        <div className={styles.charWbHeader}>
                          <SearchableSelect
                            multi
                            value={attachedWorldBookIds}
                            onChange={(ids) => { void handleWorldBookIdsChange(ids) }}
                            options={worldBooks.map((wb) => ({ value: wb.id, label: wb.name, group: wb.folder || undefined }))}
                            placeholder={t('characterEditor.addWorldBooks')}
                            ariaLabel={t('characterEditor.addWorldBooks')}
                            triggerLabel={t('characterEditor.add')}
                            triggerIcon={<Plus size={11} />}
                            searchPlaceholder={t('characterEditor.searchWorldBooks')}
                            emptyMessage={t('characterEditor.noWorldBooks')}
                            className={styles.charWbSelect}
                            portal
                            minWidth={260}
                          />
                        </div>
                        {attachedWorldBookIds.length > 0 ? (
                          <div className={styles.charWbPills}>
                            {attachedWorldBookIds.map((id) => {
                              const wb = worldBooks.find((b) => b.id === id)
                              return (
                                <span key={id} className={styles.charWbPill}>
                                  <button
                                    type="button"
                                    className={styles.charWbPillName}
                                    disabled={!wb}
                                    onClick={() => {
                                      if (!wb) return
                                      setPendingWorldBookEditId(wb.id)
                                      close()
                                      openDrawer('lorebook')
                                    }}
                                    title={wb ? t('characterEditor.openInLorebook') : undefined}
                                  >
                                    {wb?.name || t('characterEditor.unknown')}
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.charWbPillRemove}
                                    onClick={() => handleRemoveWorldBook(id)}
                                    title={t('characterEditor.removeWorldBook')}
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <span className={styles.charWbHint}>{t('characterEditor.noWorldBooksAttached')}</span>
                        )}
                      </div>

                      {getEmbeddedCharacterBookEntryCount(character.extensions) > 0 && (
                        <div className={styles.lorebookImportSection}>
                          <IconNotebook size={14} />
                          <div className={styles.lorebookImportInfo}>
                            <span className={styles.fieldLabel}>{t('characterEditor.embeddedLorebook')}</span>
                            <span className={styles.fieldHelper}>
                              {t('characterEditor.embeddedLorebookEntries', { count: getEmbeddedCharacterBookEntryCount(character.extensions) })}
                            </span>
                          </div>
                          {lorebookResult ? (
                            <span className={styles.lorebookSuccess}>{lorebookResult}</span>
                          ) : embeddedWorldBook ? (
                            <button
                              type="button"
                              className={styles.addBtn}
                              onClick={() => {
                                setPendingWorldBookEditId(embeddedWorldBook.id)
                                close()
                                openDrawer('lorebook')
                              }}
                            >
                              {t('characterEditor.openInLorebook')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={styles.addBtn}
                              disabled={lorebookImporting}
                              onClick={async () => {
                                if (!editingCharacterId) return
                                setLorebookImporting(true)
                                try {
                                  const res = await worldBooksApi.importCharacterBook(editingCharacterId)
                                  upsertWorldBookOption({
                                    id: res.world_book.id,
                                    name: res.world_book.name,
                                    folder: res.world_book.folder,
                                    metadata: res.world_book.metadata,
                                  })
                                  mutateExtensions((ext) => {
                                    const currentIds = getCharacterWorldBookIds(ext)
                                    return currentIds.includes(res.world_book.id)
                                      ? setCharacterWorldBookIds(ext, currentIds)
                                      : setCharacterWorldBookIds(ext, [...currentIds, res.world_book.id])
                                  }, true)
                                  setLorebookResult(t('characterEditor.lorebookImported', { count: res.entry_count, name: res.world_book.name }))
                                } catch {
                                  setLorebookImporting(false)
                                }
                              }}
                            >
                              {lorebookImporting ? t('characterEditor.importing') : t('characterEditor.importLorebook')}
                            </button>
                          )}
                        </div>
                      )}
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.characterRegexScripts')}</span>
                        <span className={styles.fieldHelper}>
                          {t('characterEditor.characterRegexScriptsHelper')}
                        </span>

                        {boundRegexScripts.length > 0 && (
                          <div className={styles.regexList}>
                            {boundRegexScripts.map((s) => (
                              <div key={s.id} className={styles.regexItem}>
                                <Code2 size={14} className={styles.regexIcon} />
                                <span className={clsx(styles.regexName, s.disabled && styles.regexNameDisabled)}>
                                  {s.name}
                                </span>
                                <span className={styles.regexTarget}>{s.target}</span>
                                <button
                                  type="button"
                                  className={styles.regexUnbindBtn}
                                  title={t('characterEditor.unbindRegex')}
                                  onClick={() => handleUnbindRegex(s.id)}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {(() => {
                          const unboundGlobals = regexScripts.filter(
                            (s) => s.scope === 'global' && !boundRegexScripts.some((b) => b.id === s.id)
                          )
                          if (unboundGlobals.length === 0 && boundRegexScripts.length === 0) {
                            return (
                              <span className={styles.fieldHelper}>
                                {t('characterEditor.noRegexScripts')}
                              </span>
                            )
                          }
                          if (unboundGlobals.length === 0) return null
                          return (
                            <SearchableSelect
                              value=""
                              onChange={(v) => { if (v) handleBindRegex(v) }}
                              options={unboundGlobals.map((s) => ({
                                value: s.id,
                                label: s.name,
                                sublabel: s.target.join(', '),
                              }))}
                              placeholder={t('characterEditor.bindRegexPlaceholder')}
                              searchPlaceholder={t('characterEditor.searchRegexScripts')}
                              emptyMessage={t('characterEditor.noUnboundRegex')}
                            />
                          )
                        })()}
                      </div>

                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.extensionsJson')}</span>
                        <span className={styles.fieldHelper}>
                          {t('characterEditor.extensionsJsonHelper')}
                        </span>
                        <textarea
                          className={styles.jsonTextarea}
                          value={extensionsJson}
                          onChange={(e) => handleExtensionsChange(e.target.value)}
                          spellCheck={false}
                        />
                        {jsonError && <span className={styles.jsonError}>{jsonError}</span>}
                      </div>
                    </>
                  )}

                  {activeExtensionTab && (
                    <div className={styles.extensionTabShell}>
                  {activeExtensionTab.guide && (
                    <div className={styles.extensionGuideRow}>
                      <button
                        type="button"
                        className={styles.extensionGuideButton}
                        onClick={() => setGuideOpen(true)}
                        aria-label={`Open guide for ${activeExtensionTab.title}`}
                        title="Open guide"
                      >
                        <CircleHelp size={15} strokeWidth={1.7} />
                      </button>
                    </div>
                  )}

                    <SpindleCharacterEditorTabContent
                      tab={activeExtensionTab}
                    />
                  </div>
                )}
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <ImageCropModal {...cropModalProps} />
    <ImageCropModal {...altAvatarCropProps} />
    <ContextMenu
      position={galleryContextMenu?.pos ?? null}
      items={galleryContextMenuItems}
      onClose={() => setGalleryContextMenu(null)}
    />
    <ImageLightbox src={galleryLightboxSrc} onClose={() => setGalleryLightboxSrc(null)} />
    {galleryRenameItem && (
      <ConfirmationModal
        isOpen={true}
        title={t('characterEditor.renameImageReference')}
        message={t('characterEditor.renameImageReferenceHelper')}
        variant="safe"
        inputLabel={t('characterEditor.galleryReferenceName')}
        inputPlaceholder={t('characterEditor.galleryReferenceNamePlaceholder')}
        defaultInputValue={galleryRenameItem.reference.replace(/^gallery:\/\//, '')}
        confirmText={tc('actions.save')}
        loading={galleryRenaming}
        loadingText={t('characterEditor.renamingImageReference')}
        onConfirm={(value) => void handleGalleryReferenceRename(value)}
        onCancel={() => {
          if (!galleryRenaming) setGalleryRenameItem(null)
        }}
      />
    )}
    {activeExtensionTab?.guide && (
  <GuideViewer
    isOpen={guideOpen}
    onClose={() => setGuideOpen(false)}
    guide={{
      kind: 'markdown',
      ...activeExtensionTab.guide,
    }}
    title={activeExtensionTab.title}
  />
)}

    {character && (
      <CharacterTokenReportModal
        isOpen={showTokenReport}
        onClose={() => setShowTokenReport(false)}
        characterName={name || character.name}
        items={tokenReportItems}
      />
    )}

    {character && (
      <CardUpdateModal
        isOpen={!!pendingCardUpdate}
        file={pendingCardUpdate?.file ?? null}
        preview={pendingCardUpdate?.preview ?? null}
        initialTargetCharacter={character}
        onApplied={handleCardUpdateApplied}
        onClose={() => setPendingCardUpdate(null)}
      />
    )}

    {showDeleteConfirm && (
      <ConfirmationModal
        isOpen={true}
        title={t('characterEditor.deleteCharacterTitle')}
        message={t('characterEditor.deleteCharacterMessage', { name: character?.name || t('characterEditor.thisCharacter') })}
        variant="danger"
        confirmText={t('characterEditor.delete')}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    )}
    <ContextMenu
      position={headerActionMenuPosition}
      items={headerActionMenuItems}
      onClose={() => setHeaderActionMenuPosition(null)}
    />
    </>,
    document.body
  )
}

function Field({
  label,
  helper,
  value,
  onChange,
  rows = 4,
  multiline = true,
  showTokenCount = false,
}: {
  label: string
  helper: string
  value: string
  onChange: (v: string) => void
  rows?: number
  multiline?: boolean
  showTokenCount?: boolean
}) {
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabelRow}>
        <span className={styles.fieldLabel}>{label}</span>
        {multiline && showTokenCount && (
          <TokenCountButton text={value} />
        )}
      </div>
      <span className={styles.fieldHelper}>{helper}</span>
      {multiline ? (
        <ExpandableTextarea
          className={styles.fieldTextarea}
          value={value}
          onChange={onChange}
          rows={rows}
          title={label}
          placeholder={`${label}...`}
        />
      ) : (
        <input
          type="text"
          className={styles.fieldInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${label}...`}
        />
      )}
    </div>
  )
}

function readGreetingBackground(extensions: Record<string, any>, greetingIndex: number): string | null {
  const backgrounds = extensions.greeting_backgrounds
  if (!isRecord(backgrounds)) return null
  const imageId = backgrounds[greetingIndex]
  return typeof imageId === 'string' && imageId ? imageId : null
}

function GreetingBackgroundControl({
  greetingIndex,
  imageId,
  galleryItems,
  open,
  onToggle,
  onSelect,
  labels,
}: {
  greetingIndex: number
  imageId: string | null
  galleryItems: CharacterGalleryItem[]
  open: boolean
  onToggle: () => void
  onSelect: (greetingIndex: number, imageId: string | null) => void
  labels: { set: string; clear: string; empty: string }
}) {
  return (
    <div className={styles.greetingBackgroundControl}>
      <button
        type="button"
        className={styles.greetingBackgroundButton}
        onClick={onToggle}
        title={labels.set}
        aria-label={labels.set}
        aria-expanded={open}
      >
        {imageId ? (
          <img src={imagesApi.smallUrl(imageId)} alt="" />
        ) : (
          <ImagePlus size={14} />
        )}
      </button>
      {open && (
        <div className={styles.greetingBackgroundPopover}>
          {galleryItems.length > 0 ? (
            <div className={styles.greetingBackgroundGrid}>
              {galleryItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(
                    styles.greetingBackgroundItem,
                    imageId === item.image_id && styles.greetingBackgroundItemActive,
                  )}
                  onClick={() => onSelect(greetingIndex, item.image_id)}
                  title={item.caption || labels.set}
                >
                  <img src={characterGalleryApi.smallUrl(item.image_id)} alt={item.caption || ''} />
                </button>
              ))}
            </div>
          ) : (
            <span className={styles.greetingBackgroundEmpty}>{labels.empty}</span>
          )}
          {imageId && (
            <button
              type="button"
              className={styles.greetingBackgroundClear}
              onClick={() => onSelect(greetingIndex, null)}
            >
              <X size={11} />
              {labels.clear}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function avatarExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/svg+xml') return 'svg'
  return 'png'
}

/**
 * Parse a free-form extensions blob into a VoiceRef. Returns null when the
 * shape doesn't match — `extensions` is untyped JSON so we trust nothing.
 */
function readVoiceRef(value: unknown): VoiceRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.connectionId !== 'string' || !v.connectionId) return null
  const voice = typeof v.voice === 'string' ? v.voice : ''
  const parameters =
    v.parameters && typeof v.parameters === 'object'
      ? { speed: typeof (v.parameters as any).speed === 'number' ? (v.parameters as any).speed : undefined }
      : undefined
  return { connectionId: v.connectionId, voice, parameters }
}

/**
 * Character editor "Voice" tab. Owns the per-character default voice stored
 * at `character.extensions.ttsVoice`. The picker lazy-loads the TTS profile
 * list on mount so users who arrive here without having visited the global
 * Voice settings still see their connections.
 */
function CharacterVoiceTab({
  value,
  onChange,
}: {
  value: VoiceRef | null
  onChange: (next: VoiceRef | null) => void
}) {
  const { t } = useTranslation('panels')
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const setTtsProfiles = useStore((s) => s.setTtsProfiles)
  const setTtsProviders = useStore((s) => s.setTtsProviders)
  const openDrawer = useStore((s) => s.openDrawer)

  useEffect(() => {
    if (ttsProfiles.length === 0) {
      ttsConnectionsApi.list().then((res) => setTtsProfiles(res.data || [])).catch(() => {})
    }
    ttsConnectionsApi.providers().then((res) => setTtsProviders(res.providers || [])).catch(() => {})
  }, [ttsProfiles.length, setTtsProfiles, setTtsProviders])

  return (
    <div className={styles.fieldGroup}>
      <span className={styles.fieldLabel}>{t('characterEditor.characterVoice')}</span>
      <span className={styles.fieldHelper}>
        {t('characterEditor.characterVoiceHelper')}
      </span>

      {ttsProfiles.length === 0 ? (
        <div className={styles.fieldHelper} style={{ marginTop: 8 }}>
          {t('characterEditor.noTtsConnections')}{' '}
          <button
            type="button"
            onClick={() => openDrawer?.('connections')}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent, #6aa3ff)', cursor: 'pointer', textDecoration: 'underline' }}
          >
            {t('characterEditor.addTtsInConnections')}
          </button>
          .
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <VoicePicker
            value={value}
            onChange={onChange}
            ariaLabel={t('characterEditor.characterVoiceAria')}
            clearLabel={t('characterEditor.useGlobalVoice')}
            portal
          />
        </div>
      )}
    </div>
  )
}
