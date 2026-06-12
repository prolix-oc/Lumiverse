import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Upload, Trash2, Copy, MessageSquare, User, Plus, ImagePlus, Download, Code2 } from 'lucide-react'
import { IconNotebook } from '@tabler/icons-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { imagesApi } from '@/api/images'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import { uuidv7 } from '@/lib/uuid'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import ImageCropModal from '@/components/shared/ImageCropModal'
import LazyImage from '@/components/shared/LazyImage'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useLongPress } from '@/hooks/useLongPress'
import type { Character, CharacterGalleryItem } from '@/types/api'
import type { WallpaperRef } from '@/types/store'
import { toast } from '@/lib/toast'
import { Button } from '@/components/shared/FormComponents'
import SearchableSelect from '@/components/shared/SearchableSelect'
import VoicePicker from '@/components/shared/VoicePicker'
import { ttsConnectionsApi } from '@/api/tts-connections'
import type { VoiceRef } from '@/types/api'
import { filterWorldBooksForChatContextAttachment } from '@/lib/worldBookIndexPrompt'
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
import { VoiceGuidanceEditor } from '@/components/dream-weaver/components/VoiceGuidanceEditor'
import {
  EMPTY_DREAM_WEAVER_VOICE_GUIDANCE,
  getDreamWeaverAppearanceText,
  getDreamWeaverCharacterMetadata,
} from '@/lib/dream-weaver-character'

const DEBOUNCE_MS = 2000

type TabId = 'core' | 'system' | 'greetings' | 'identity' | 'gallery' | 'expressions' | 'voice' | 'imageLora' | 'advanced'

interface GalleryGridItemProps {
  item: CharacterGalleryItem
  onRemove: (itemId: string) => void
  onOpenMenu: (item: CharacterGalleryItem, pos: ContextMenuPos) => void
}

function GalleryGridItem({ item, onRemove, onOpenMenu }: GalleryGridItemProps) {
  const { t } = useTranslation('panels')
  const longPress = useLongPress({
    onLongPress: (pos) => onOpenMenu(item, pos),
  })

  return (
    <div className={styles.galleryItem} {...longPress}>
      <LazyImage
        src={characterGalleryApi.smallUrl(item.image_id)}
        alt={item.caption || t('characterEditor.galleryImage')}
        className={styles.galleryThumb}
        fallback={<div className={styles.galleryThumbPlaceholder} />}
      />
      <button
        type="button"
        className={styles.galleryRemoveBtn}
        onClick={() => onRemove(item.id)}
        title={t('characterEditor.removeFromGallery')}
      >
        <X size={12} />
      </button>
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export default function CharacterEditorPage() {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')

  const tabs = useMemo<{ id: TabId; label: string }[]>(() => [
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
  const setPendingWorldBookEditId = useStore((s) => s.setPendingWorldBookEditId)
  const allCharacters = useStore((s) => s.characters)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const setActiveChatAvatarId = useStore((s) => s.setActiveChatAvatarId)
  const setActiveChatWallpaper = useStore((s) => s.setActiveChatWallpaper)
  const setSceneBackground = useStore((s) => s.setSceneBackground)
  const updateCharInStore = useStore((s) => s.updateCharacter)
  const regexScripts = useStore((s) => s.regexScripts)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const browser = useCharacterBrowser()

  const character = allCharacters.find((c) => c.id === editingCharacterId) ?? null
  const isOpen = !!editingCharacterId

  const [activeTab, setActiveTab] = useState<TabId>('core')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([])
  const [alternateCharacterName, setAlternateCharacterName] = useState('')
  const [extensionsJson, setExtensionsJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [lorebookImporting, setLorebookImporting] = useState(false)
  const [lorebookResult, setLorebookResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [worldBooks, setWorldBooks] = useState<Array<{ id: string; name: string; folder: string }>>([])
  const [galleryUploading, setGalleryUploading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [galleryContextMenu, setGalleryContextMenu] = useState<{ pos: ContextMenuPos; item: CharacterGalleryItem } | null>(null)
  const [avatarUploadProgress, setAvatarUploadProgress] = useState<number | null>(null)
  const [altAvatarUploadProgress, setAltAvatarUploadProgress] = useState<number | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const galleryFileRef = useRef<HTMLInputElement>(null)
  const savingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastSyncedId = useRef<string | null>(null)

  const close = useCallback(() => setEditingCharacterId(null), [setEditingCharacterId])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, close])

  // Reset tab and force re-sync when switching to a different character.
  // Keyed on editingCharacterId (a stable string) so store-driven object
  // reference changes can never accidentally reset the active tab.
  useEffect(() => {
    lastSyncedId.current = null
    if (editingCharacterId) {
      setActiveTab('core')
    }
  }, [editingCharacterId])

  // Sync form fields from character data — runs when the character object
  // changes, but the lastSyncedId guard skips redundant syncs for the same
  // character (e.g. after our own debounced save updates the store).
  useEffect(() => {
    if (!character) return
    if (lastSyncedId.current === character.id) return
    lastSyncedId.current = character.id
    setName(character.name)
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
    setAlternateCharacterName(character.extensions?.alternate_character_name || '')
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

  // Gallery
  const fetchGallery = useCallback(() => {
    if (!editingCharacterId) return
    characterGalleryApi.list(editingCharacterId).then(setGalleryItems).catch(() => {})
  }, [editingCharacterId])

  useEffect(() => {
    fetchGallery()
  }, [fetchGallery])

  const boundRegexScripts = useMemo(
    () => regexScripts.filter((s) => s.scope === 'character' && s.scope_id === editingCharacterId),
    [regexScripts, editingCharacterId]
  )

  useEffect(() => {
    if (!editingCharacterId) return
    loadRegexScripts().catch(() => {})
  }, [editingCharacterId, loadRegexScripts])

  const upsertWorldBookOption = useCallback((book: { id: string; name: string; folder?: string }) => {
    const normalized = { id: book.id, name: book.name, folder: book.folder ?? '' }
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
        if (!cancelled) setWorldBooks(res.data.map((b) => ({ id: b.id, name: b.name, folder: b.folder || '' })))
      } catch {
        // no-op
      }
    }
    loadWorldBooks()
    return () => {
      cancelled = true
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
      if (!editingCharacterId) return
      await characterGalleryApi.remove(editingCharacterId, itemId)
      setGalleryItems((prev) => prev.filter((i) => i.id !== itemId))
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

  const galleryContextMenuItems: ContextMenuEntry[] = galleryContextMenu ? [
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
    const MD_RE = /!\[[^\]]*\]\([^)]+\)/g
    const IMG_RE = /<img[^>]+src=["'][^"']+["']/gi
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
      for (const m of t.matchAll(MD_RE)) {
        const url = m[0].match(/\(([^)]+)\)/)?.[1]
        if (url && (url.startsWith('http') || url.startsWith('data:'))) seen.add(url)
      }
      for (const m of t.matchAll(IMG_RE)) {
        const url = m[0].match(/src=["']([^"']+)["']/)?.[1]
        if (url && (url.startsWith('http') || url.startsWith('data:'))) seen.add(url)
      }
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
    [editingCharacterId, browser.updateCharacter, showSaving]
  )

  // ── Atomic extensions mutation pipeline ──────────────────────────────
  // World book attachments, alternate fields, alternate avatars, and the
  // raw extensions textarea all write to the same `extensions` blob. Without
  // a single source of truth, an immediate save (e.g. toggling a world book)
  // and a debounced save (e.g. typing in an alt-field variant) can race and
  // clobber each other — the debounced save fires last with stale data and
  // wipes the world book change. The pendingExtensionsRef tracks the latest
  // mutated extensions so every callsite reads from the freshest value, and
  // mutateExtensions cancels any pending debounced extensions save when an
  // immediate save lands so the in-flight changes get persisted together.
  const pendingExtensionsRef = useRef<Record<string, any> | null>(null)

  const workingExtensions = useMemo(() => {
    try {
      const parsed = JSON.parse(extensionsJson)
      if (isRecord(parsed)) return parsed
    } catch {
    }

    return pendingExtensionsRef.current ?? character?.extensions ?? {}
  }, [extensionsJson, character?.extensions])

  const dreamWeaverMetadata = useMemo(
    () => getDreamWeaverCharacterMetadata({ extensions: workingExtensions } as Pick<Character, 'extensions'>),
    [workingExtensions],
  )

  const flushExtensionsSave = useCallback(async () => {
    if (!editingCharacterId) return
    clearTimeout(timers.current['extensions'])
    timers.current['extensions'] = undefined as unknown as ReturnType<typeof setTimeout>
    const next = pendingExtensionsRef.current
    if (!next) return
    pendingExtensionsRef.current = null
    showSaving()
    await browser.updateCharacter(editingCharacterId, { extensions: next })
  }, [editingCharacterId, browser.updateCharacter, showSaving])

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

  const mutateDreamWeaver = useCallback(
    (mutator: (metadata: Record<string, any>) => Record<string, any>) => {
      mutateExtensions((ext) => {
        const next = { ...ext }
        const currentDreamWeaver = isRecord(ext.dream_weaver) ? { ...ext.dream_weaver } : {}
        const updatedDreamWeaver = mutator(currentDreamWeaver)

        if (Object.keys(updatedDreamWeaver).length > 0) {
          next.dream_weaver = updatedDreamWeaver
        } else {
          delete next.dream_weaver
        }

        return next
      }, false)
    },
    [mutateExtensions],
  )

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

  const handleDreamWeaverAppearanceChange = useCallback(
    (value: string) => {
      mutateDreamWeaver((metadata) => {
        const next = { ...metadata }
        if (value.trim()) next.appearance = value
        else delete next.appearance
        return next
      })
    },
    [mutateDreamWeaver],
  )

  const handleDreamWeaverVoiceChange = useCallback(
    (voiceGuidance: typeof EMPTY_DREAM_WEAVER_VOICE_GUIDANCE) => {
      mutateDreamWeaver((metadata) => {
        const hasStructuredRules = Object.values(voiceGuidance.rules).some((items) => items.length > 0)
        const hasVoiceContent = hasStructuredRules || Boolean(voiceGuidance.compiled.trim())
        const next = { ...metadata }

        if (hasVoiceContent) {
          next.voice_guidance = {
            compiled: voiceGuidance.compiled,
            rules: {
              baseline: [...voiceGuidance.rules.baseline],
              rhythm: [...voiceGuidance.rules.rhythm],
              diction: [...voiceGuidance.rules.diction],
              quirks: [...voiceGuidance.rules.quirks],
              hard_nos: [...voiceGuidance.rules.hard_nos],
            },
          }
        } else {
          delete next.voice_guidance
        }

        return next
      })
    },
    [mutateDreamWeaver],
  )

  const handleAlternatesChange = useCallback(
    (field: string, variants: Array<{ id: string; label: string; content: string }>) => {
      mutateExtensions((ext) => {
        const currentAltFields = ext.alternate_fields || {}
        const updatedAltFields = { ...currentAltFields, [field]: variants }
        if (variants.length === 0) delete updatedAltFields[field]
        const next = { ...ext, alternate_fields: updatedAltFields }
        if (Object.keys(updatedAltFields).length === 0) delete next.alternate_fields
        return next
      }, false)
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

  const handleAvatarSelect = useCallback(
    async (imageId: string | null) => {
      if (!activeChatId) return
      setActiveChatAvatarId(imageId)
      try {
        // Atomic merge — server re-reads the latest chat row so background
        // writers can't clobber this avatar binding.
        await chatsApi.patchMetadata(activeChatId, { active_avatar_id: imageId ?? null })
      } catch (err) {
        console.error('[Editor] Avatar select failed:', err)
      }
    },
    [activeChatId, setActiveChatAvatarId]
  )

  const handleAddTag = useCallback(() => {
    if (!editingCharacterId) return
    const tag = newTag.trim()
    if (!tag || tags.includes(tag)) return
    const updated = [...tags, tag]
    setTags(updated)
    setNewTag('')
    showSaving()
    browser.updateCharacter(editingCharacterId, { tags: updated })
  }, [newTag, tags, editingCharacterId, browser.updateCharacter, showSaving])

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (!editingCharacterId) return
      const updated = tags.filter((t) => t !== tag)
      setTags(updated)
      showSaving()
      browser.updateCharacter(editingCharacterId, { tags: updated })
    },
    [tags, editingCharacterId, browser.updateCharacter, showSaving]
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

  const handleAddGreeting = useCallback(() => {
    const updated = [...alternateGreetings, '']
    setAlternateGreetings(updated)
    if (editingCharacterId) {
      showSaving()
      browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
    }
  }, [alternateGreetings, editingCharacterId, browser.updateCharacter, showSaving])

  const handleRemoveGreeting = useCallback(
    (index: number) => {
      const updated = alternateGreetings.filter((_, i) => i !== index)
      setAlternateGreetings(updated)
      if (editingCharacterId) {
        showSaving()
        browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
      }
    },
    [alternateGreetings, editingCharacterId, browser.updateCharacter, showSaving]
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
    [updateRegexScript]
  )

  const clearActivatedWorldInfo = useStore((s) => s.clearActivatedWorldInfo)

  const attachedWorldBookIds = useMemo(
    () => getCharacterWorldBookIds(character?.extensions),
    [character?.extensions]
  )

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

  // Separate crop flow for alternate avatar uploads
  const handleAltAvatarCropComplete = useCallback(
    async (croppedFile: File, originalFile: File) => {
      if (!editingCharacterId || !character) return
      setAltAvatarUploadProgress(0)
      try {
        // Upload original (full aspect ratio) for lightbox
        const originalImage = await imagesApi.upload(originalFile, (p) => setAltAvatarUploadProgress(Math.round(p * 0.4)))
        // Upload cropped for display
        const image = await imagesApi.upload(croppedFile, (p) => setAltAvatarUploadProgress(40 + Math.round(p * 0.6)))
        const newId = uuidv7()
        const entry: AlternateAvatarEntry = {
          id: newId,
          image_id: image.id,
          original_image_id: originalImage.id,
          label: t('characterEditor.newAvatar'),
        }
        mutateExtensions((ext) => {
          const currentAlts = (ext.alternate_avatars || []) as AlternateAvatarEntry[]
          return { ...ext, alternate_avatars: [...currentAlts, entry] }
        }, true)
      } catch (err) {
        console.error('[AltAvatar] Upload failed:', err)
      } finally {
        setAltAvatarUploadProgress(null)
      }
    },
    [mutateExtensions]
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

  // Actions
  const handleDelete = useCallback(async () => {
    if (!editingCharacterId) return
    await browser.deleteCharacter(editingCharacterId)
    close()
    setShowDeleteConfirm(false)
  }, [editingCharacterId, browser.deleteCharacter, close])

  const handleDuplicate = useCallback(async () => {
    if (!editingCharacterId) return
    const dup = await browser.duplicateCharacter(editingCharacterId)
    setEditingCharacterId(dup.id)
  }, [editingCharacterId, browser.duplicateCharacter, setEditingCharacterId])

  const handleOpenChat = useCallback(() => {
    if (!character) return
    close()
    browser.openChat(character)
  }, [character, browser.openChat, close])

  const [showExportMenu, setShowExportMenu] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  const handleExport = useCallback(async (format: 'json' | 'png' | 'charx') => {
    if (!editingCharacterId || !character) return
    setExporting(true)
    setShowExportMenu(false)
    const formatLabel = format === 'charx' ? 'CHARX' : format === 'png' ? 'PNG' : 'JSON'
    const toastId = toast.info(t('characterEditor.preparingExport', { format: formatLabel }), { title: t('characterEditor.exporting'), duration: 60_000, dismissible: false })
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
                <span className={styles.creatorText}>{t('characterEditor.notFound')}</span>
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
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className={styles.hiddenInput}
                      onChange={handleFileSelected}
                    />
                  </div>

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
                    <Button size="icon" variant="ghost" onClick={handleOpenChat} title={t('characterEditor.openChat')}>
                      <MessageSquare size={14} />
                    </Button>
                    <div className={styles.exportWrapper} ref={exportMenuRef}>
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
                    <Button size="icon" variant="ghost" onClick={handleDuplicate} title={t('characterEditor.duplicate')}>
                      <Copy size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="danger-ghost"
                      onClick={() => setShowDeleteConfirm(true)}
                      title={tc('actions.delete')}
                    >
                      <Trash2 size={14} />
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
                      className={clsx(styles.tab, activeTab === tab.id && styles.tabActive)}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className={styles.tabContent}>
                  {activeTab === 'core' && (
                    <>
                      {dreamWeaverMetadata && (
                        <Field
                          label={t('characterEditor.appearance')}
                          helper={t('characterEditor.appearanceHelper')}
                          value={getDreamWeaverAppearanceText(dreamWeaverMetadata)}
                          onChange={handleDreamWeaverAppearanceChange}
                          rows={4}
                        />
                      )}
                      <AlternateFieldEditor
                        label={t('characterEditor.description')}
                        helper={t('characterEditor.descriptionHelper')}
                        value={fields.description || ''}
                        alternates={character?.extensions?.alternate_fields?.description}
                        onChange={(v) => handleFieldChange('description', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('description', variants)}
                        rows={5}
                      />
                      <AlternateFieldEditor
                        label={t('characterEditor.personality')}
                        helper={t('characterEditor.personalityHelper')}
                        value={fields.personality || ''}
                        alternates={character?.extensions?.alternate_fields?.personality}
                        onChange={(v) => handleFieldChange('personality', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('personality', variants)}
                        rows={4}
                      />
                      <AlternateFieldEditor
                        label={t('characterEditor.scenario')}
                        helper={t('characterEditor.scenarioHelper')}
                        value={fields.scenario || ''}
                        alternates={character?.extensions?.alternate_fields?.scenario}
                        onChange={(v) => handleFieldChange('scenario', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('scenario', variants)}
                        rows={3}
                      />
                    </>
                  )}

                  {activeTab === 'system' && (
                    <>
                      {dreamWeaverMetadata && (
                        <div className={styles.fieldGroup}>
                          <span className={styles.fieldLabel}>{t('characterEditor.voiceGuidance')}</span>
                          <span className={styles.fieldHelper}>
                            {t('characterEditor.voiceGuidanceHelper')}
                          </span>
                          <VoiceGuidanceEditor
                            voice={dreamWeaverMetadata.voiceGuidance || EMPTY_DREAM_WEAVER_VOICE_GUIDANCE}
                            onChange={handleDreamWeaverVoiceChange}
                          />
                        </div>
                      )}
                      <Field
                        label={t('characterEditor.systemPrompt')}
                        helper={t('characterEditor.systemPromptHelper')}
                        value={fields.system_prompt || ''}
                        onChange={(v) => handleFieldChange('system_prompt', v)}
                        rows={6}
                      />
                      <Field
                        label={t('characterEditor.postHistory')}
                        helper={t('characterEditor.postHistoryHelper')}
                        value={fields.post_history_instructions || ''}
                        onChange={(v) => handleFieldChange('post_history_instructions', v)}
                        rows={4}
                      />
                    </>
                  )}

                  {activeTab === 'greetings' && (
                    <>
                      <Field
                        label={t('characterEditor.firstMessage')}
                        helper={t('characterEditor.firstMessageHelper')}
                        value={fields.first_mes || ''}
                        onChange={(v) => handleFieldChange('first_mes', v)}
                        rows={5}
                      />
                      <Field
                        label={t('characterEditor.messageExamples')}
                        helper={t('characterEditor.messageExamplesHelper')}
                        value={fields.mes_example || ''}
                        onChange={(v) => handleFieldChange('mes_example', v)}
                        rows={5}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>{t('characterEditor.alternateGreetings')}</span>
                        <span className={styles.fieldHelper}>
                          {t('characterEditor.alternateGreetingsHelper')}
                        </span>
                        {alternateGreetings.map((greeting, i) => (
                          <div key={i} className={styles.greetingItem}>
                            <div className={styles.greetingHeader}>
                              <span className={styles.greetingLabel}>{t('characterEditor.greetingNumber', { n: i + 1 })}</span>
                              <button
                                type="button"
                                className={styles.removeBtn}
                                onClick={() => handleRemoveGreeting(i)}
                                title={t('characterEditor.remove')}
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <ExpandableTextarea
                              className={styles.fieldTextarea}
                              value={greeting}
                              onChange={(v) => handleGreetingChange(i, v)}
                              rows={3}
                              title={t('characterEditor.greetingNumber', { n: i + 1 })}
                              placeholder={t('characterEditor.alternateGreetingPlaceholder')}
                            />
                          </div>
                        ))}
                        <button type="button" className={styles.addBtn} onClick={handleAddGreeting}>
                          <Plus size={12} /> {t('characterEditor.addGreeting')}
                        </button>
                      </div>
                    </>
                  )}

                  {activeTab === 'identity' && (
                    <>
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
                      <Field
                        label={t('characterEditor.creatorNotes')}
                        helper={t('characterEditor.creatorNotesHelper')}
                        value={fields.creator_notes || ''}
                        onChange={(v) => handleFieldChange('creator_notes', v)}
                        rows={4}
                      />
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
                          <div className={styles.tagAdd}>
                            <input
                              type="text"
                              className={styles.tagInput}
                              value={newTag}
                              onChange={(e) => setNewTag(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                              placeholder={t('characterEditor.addTag')}
                            />
                            <button
                              type="button"
                              className={styles.tagAddBtn}
                              onClick={handleAddTag}
                              disabled={!newTag.trim()}
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                      <AlternateAvatarManager
                        primaryImageId={character?.image_id || null}
                        alternates={(character?.extensions?.alternate_avatars || []) as AlternateAvatarEntry[]}
                        onChange={handleAlternateAvatarsChange}
                        openCropFlow={openAltAvatarCropFlow}
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

                      <div className={styles.galleryGrid}>
                        {galleryItems.map((item) => (
                          <GalleryGridItem
                            key={item.id}
                            item={item}
                            onRemove={handleGalleryRemove}
                            onOpenMenu={(menuItem, pos) => setGalleryContextMenu({ item: menuItem, pos })}
                          />
                        ))}

                        <button
                          type="button"
                          className={styles.galleryAddBtn}
                          onClick={() => galleryFileRef.current?.click()}
                          disabled={galleryUploading}
                        >
                          <ImagePlus size={20} />
                          <span>{galleryUploading ? t('characterEditor.uploading') : t('characterEditor.addImages')}</span>
                        </button>
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
                    <ExpressionEditorTab characterId={character.id} />
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
                                  upsertWorldBookOption({ id: res.world_book.id, name: res.world_book.name, folder: res.world_book.folder })
                                  mutateExtensions((ext) => {
                                    const currentIds = getCharacterWorldBookIds(ext)
                                    return setCharacterWorldBookIds(ext, [...currentIds, res.world_book.id])
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
}: {
  label: string
  helper: string
  value: string
  onChange: (v: string) => void
  rows?: number
  multiline?: boolean
}) {
  return (
    <div className={styles.fieldGroup}>
      <span className={styles.fieldLabel}>{label}</span>
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
