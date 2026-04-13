import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Upload, Trash2, Copy, MessageSquare, User, Plus, ImagePlus, Download, Code2, ChevronDown } from 'lucide-react'
import { IconNotebook } from '@tabler/icons-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { imagesApi } from '@/api/images'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import { regexApi } from '@/api/regex'
import { useStore } from '@/store'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import { uuidv7 } from '@/lib/uuid'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import { getCharacterAvatarLargeUrl } from '@/lib/avatarUrls'
import ImageCropModal from '@/components/shared/ImageCropModal'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { Character, CharacterGalleryItem } from '@/types/api'
import type { RegexScript } from '@/types/regex'
import { toast } from '@/lib/toast'
import { Button } from '@/components/shared/FormComponents'
import styles from './CharacterEditorPage.module.css'
import clsx from 'clsx'
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from '@/utils/character-world-books'
import ExpressionEditorTab from './ExpressionEditorTab'
import AlternateFieldEditor from './AlternateFieldEditor'
import AlternateAvatarManager from './AlternateAvatarManager'
import type { AlternateAvatarEntry } from './AlternateAvatarManager'

const DEBOUNCE_MS = 2000

type TabId = 'core' | 'system' | 'greetings' | 'identity' | 'gallery' | 'expressions' | 'advanced'

const TABS: { id: TabId; label: string }[] = [
  { id: 'core', label: 'Core Prompts' },
  { id: 'system', label: 'System' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'identity', label: 'Identity' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'expressions', label: 'Expressions' },
  { id: 'advanced', label: 'Advanced' },
]

export default function CharacterEditorPage() {
  const editingCharacterId = useStore((s) => s.editingCharacterId)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const allCharacters = useStore((s) => s.characters)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const setActiveChatAvatarId = useStore((s) => s.setActiveChatAvatarId)
  const updateCharInStore = useStore((s) => s.updateCharacter)
  const browser = useCharacterBrowser()

  const character = allCharacters.find((c) => c.id === editingCharacterId) ?? null
  const isOpen = !!editingCharacterId

  const [activeTab, setActiveTab] = useState<TabId>('core')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([])
  const [extensionsJson, setExtensionsJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [lorebookImporting, setLorebookImporting] = useState(false)
  const [lorebookResult, setLorebookResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [worldBooks, setWorldBooks] = useState<Array<{ id: string; name: string }>>([])
  const [boundRegexScripts, setBoundRegexScripts] = useState<RegexScript[]>([])
  const [allRegexScripts, setAllRegexScripts] = useState<RegexScript[]>([])
  const [galleryUploading, setGalleryUploading] = useState(false)
  const [extracting, setExtracting] = useState(false)
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

  // Fetch regex scripts (all + character-bound) when character changes
  const fetchRegexScripts = useCallback(async () => {
    if (!editingCharacterId) return
    try {
      const [allRes, boundRes] = await Promise.all([
        regexApi.list({ limit: 500 }),
        regexApi.list({ limit: 500, scope: 'character', character_id: editingCharacterId }),
      ])
      setAllRegexScripts(allRes.data)
      // Filter to only scripts actually scoped to this character
      setBoundRegexScripts(boundRes.data.filter((s) => s.scope === 'character' && s.scope_id === editingCharacterId))
    } catch { /* no-op */ }
  }, [editingCharacterId])

  useEffect(() => {
    fetchRegexScripts()
  }, [fetchRegexScripts])

  useEffect(() => {
    let cancelled = false
    const loadWorldBooks = async () => {
      try {
        const res = await worldBooksApi.list({ limit: 200 })
        if (!cancelled) setWorldBooks(res.data.map((b) => ({ id: b.id, name: b.name })))
      } catch {
        // no-op
      }
    }
    loadWorldBooks()
    return () => {
      cancelled = true
    }
  }, [])

  const handleGalleryUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !editingCharacterId) return
      e.target.value = ''
      setGalleryUploading(true)
      try {
        const item = await characterGalleryApi.upload(editingCharacterId, file)
        setGalleryItems((prev) => [...prev, item])
      } catch {
        // upload failed
      } finally {
        setGalleryUploading(false)
      }
    },
    [editingCharacterId]
  )

  const handleGalleryRemove = useCallback(
    async (itemId: string) => {
      if (!editingCharacterId) return
      await characterGalleryApi.remove(editingCharacterId, itemId)
      setGalleryItems((prev) => prev.filter((i) => i.id !== itemId))
    },
    [editingCharacterId]
  )

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
        setJsonError('Invalid JSON')
      }
    },
    [flushExtensionsSave]
  )

  const handleBindRegex = useCallback(
    async (scriptId: string) => {
      if (!editingCharacterId) return
      try {
        await regexApi.update(scriptId, { scope: 'character', scope_id: editingCharacterId })
        fetchRegexScripts()
      } catch (err: any) {
        toast.error(err.body?.error || err.message || 'Failed to bind regex')
      }
    },
    [editingCharacterId, fetchRegexScripts]
  )

  const handleUnbindRegex = useCallback(
    async (scriptId: string) => {
      try {
        await regexApi.update(scriptId, { scope: 'global', scope_id: null })
        fetchRegexScripts()
      } catch (err: any) {
        toast.error(err.body?.error || err.message || 'Failed to unbind regex')
      }
    },
    [fetchRegexScripts]
  )

  const clearActivatedWorldInfo = useStore((s) => s.clearActivatedWorldInfo)

  const attachedWorldBookIds = useMemo(
    () => getCharacterWorldBookIds(character?.extensions),
    [character?.extensions]
  )

  const handleToggleWorldBook = useCallback(
    (worldBookId: string) => {
      mutateExtensions((ext) => {
        const currentIds = getCharacterWorldBookIds(ext)
        const nextIds = currentIds.includes(worldBookId)
          ? currentIds.filter((id) => id !== worldBookId)
          : [...currentIds, worldBookId]
        if (nextIds.length === 0) clearActivatedWorldInfo()
        return setCharacterWorldBookIds(ext, nextIds)
      }, true)
    },
    [mutateExtensions, clearActivatedWorldInfo]
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

  // World book popover state
  const [wbPopoverOpen, setWbPopoverOpen] = useState(false)
  const wbAddBtnRef = useRef<HTMLButtonElement>(null)
  const wbPopoverRef = useRef<HTMLDivElement>(null)
  const wbFieldGroupRef = useRef<HTMLDivElement>(null)
  const [wbPopoverPos, setWbPopoverPos] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    if (!wbPopoverOpen) return
    const handleClick = (e: MouseEvent) => {
      if (
        wbPopoverRef.current && !wbPopoverRef.current.contains(e.target as Node) &&
        wbAddBtnRef.current && !wbAddBtnRef.current.contains(e.target as Node)
      ) {
        setWbPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [wbPopoverOpen])

  const openWbPopover = useCallback(() => {
    setWbPopoverOpen((prev) => {
      const next = !prev
      if (next && wbAddBtnRef.current && wbFieldGroupRef.current) {
        const btnRect = wbAddBtnRef.current.getBoundingClientRect()
        const containerRect = wbFieldGroupRef.current.getBoundingClientRect()
        setWbPopoverPos({
          top: btnRect.bottom + 4,
          left: containerRect.left,
          width: containerRect.width,
        })
      }
      return next
    })
  }, [])

  // Avatar
  const handleCropComplete = useCallback(
    async (croppedFile: File, _originalFile: File) => {
      if (!editingCharacterId) return
      setAvatarUploadProgress(0)
      try {
        const updated = await charactersApi.uploadAvatar(editingCharacterId, croppedFile, (p) => setAvatarUploadProgress(p))
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
          label: 'New Avatar',
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
    const toastId = toast.info(`Preparing ${formatLabel} export\u2026`, { title: 'Exporting', duration: 60_000, dismissible: false })
    try {
      await charactersApi.exportCharacter(editingCharacterId, format, character.name)
      toast.dismiss(toastId)
      toast.success(`${character.name} exported as ${formatLabel}`)
    } catch (err) {
      console.error('[Export] Failed:', err)
      toast.dismiss(toastId)
      toast.error(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setExporting(false)
    }
  }, [editingCharacterId, character])

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
                <span className={styles.creatorText}>Character not found</span>
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
                    title="Click or drop to change avatar"
                  >
                    <LazyImage
                      key={avatarKey}
                      src={getCharacterAvatarLargeUrl(character) ?? ''}
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
                      placeholder="Character name"
                    />
                    {character.creator && <span className={styles.creatorText}>by {character.creator}</span>}
                  </div>

                  {saving && <span className={styles.savingIndicator}>Saving...</span>}

                  <div className={styles.headerActions}>
                    <Button size="icon" variant="ghost" onClick={handleOpenChat} title="Open Chat">
                      <MessageSquare size={14} />
                    </Button>
                    <div className={styles.exportWrapper} ref={exportMenuRef}>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => !exporting && setShowExportMenu((v) => !v)}
                        title="Export"
                        disabled={exporting}
                      >
                        {exporting
                          ? <Spinner size={14} fast />
                          : <Download size={14} />}
                      </Button>
                      {showExportMenu && (
                        <div className={styles.exportDropdown}>
                          <button onClick={() => handleExport('json')}>Export as JSON (CCSv3)</button>
                          <button onClick={() => handleExport('png')}>Export as PNG (Embedded)</button>
                          <button onClick={() => handleExport('charx')}>Export as CHARX (Lumiverse)</button>
                        </div>
                      )}
                    </div>
                    <Button size="icon" variant="ghost" onClick={handleDuplicate} title="Duplicate">
                      <Copy size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="danger-ghost"
                      onClick={() => setShowDeleteConfirm(true)}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>

                  <CloseButton onClick={close} variant="solid" />
                </div>

                {/* Tab bar */}
                <div className={styles.tabBar}>
                  {TABS.map((tab) => (
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
                      <AlternateFieldEditor
                        label="Description"
                        helper="The character's physical appearance, backstory, and other details."
                        value={fields.description || ''}
                        alternates={character?.extensions?.alternate_fields?.description}
                        onChange={(v) => handleFieldChange('description', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('description', variants)}
                        rows={5}
                      />
                      <AlternateFieldEditor
                        label="Personality"
                        helper="Key personality traits and behavioral patterns."
                        value={fields.personality || ''}
                        alternates={character?.extensions?.alternate_fields?.personality}
                        onChange={(v) => handleFieldChange('personality', v)}
                        onAlternatesChange={(variants) => handleAlternatesChange('personality', variants)}
                        rows={4}
                      />
                      <AlternateFieldEditor
                        label="Scenario"
                        helper="The setting or situation for the roleplay."
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
                      <Field
                        label="System Prompt"
                        helper="Instructions injected at the start of every conversation."
                        value={fields.system_prompt || ''}
                        onChange={(v) => handleFieldChange('system_prompt', v)}
                        rows={6}
                      />
                      <Field
                        label="Post-History Instructions"
                        helper="Instructions injected after the chat history (jailbreak position)."
                        value={fields.post_history_instructions || ''}
                        onChange={(v) => handleFieldChange('post_history_instructions', v)}
                        rows={4}
                      />
                    </>
                  )}

                  {activeTab === 'greetings' && (
                    <>
                      <Field
                        label="First Message"
                        helper="The opening message the character sends when starting a new chat."
                        value={fields.first_mes || ''}
                        onChange={(v) => handleFieldChange('first_mes', v)}
                        rows={5}
                      />
                      <Field
                        label="Message Examples"
                        helper="Example dialogues showing how the character speaks (use <START> to separate)."
                        value={fields.mes_example || ''}
                        onChange={(v) => handleFieldChange('mes_example', v)}
                        rows={5}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Alternate Greetings</span>
                        <span className={styles.fieldHelper}>
                          Alternative first messages that can be randomly selected.
                        </span>
                        {alternateGreetings.map((greeting, i) => (
                          <div key={i} className={styles.greetingItem}>
                            <div className={styles.greetingHeader}>
                              <span className={styles.greetingLabel}>Greeting #{i + 1}</span>
                              <button
                                type="button"
                                className={styles.removeBtn}
                                onClick={() => handleRemoveGreeting(i)}
                                title="Remove"
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <ExpandableTextarea
                              className={styles.fieldTextarea}
                              value={greeting}
                              onChange={(v) => handleGreetingChange(i, v)}
                              rows={3}
                              title={`Greeting #${i + 1}`}
                              placeholder="Alternate greeting..."
                            />
                          </div>
                        ))}
                        <button type="button" className={styles.addBtn} onClick={handleAddGreeting}>
                          <Plus size={12} /> Add Greeting
                        </button>
                      </div>
                    </>
                  )}

                  {activeTab === 'identity' && (
                    <>
                      <Field
                        label="Alternate Character Name"
                        helper="Used as {{char}} in prompts and as the chat display name. Leaves the card's title untouched."
                        value={character?.extensions?.alternate_character_name || ''}
                        onChange={handleAlternateCharacterNameChange}
                        multiline={false}
                      />
                      <Field
                        label="Creator"
                        helper="Who created this character."
                        value={fields.creator || ''}
                        onChange={(v) => handleFieldChange('creator', v)}
                        multiline={false}
                      />
                      <Field
                        label="Creator Notes"
                        helper="Notes from the creator about how to use the character."
                        value={fields.creator_notes || ''}
                        onChange={(v) => handleFieldChange('creator_notes', v)}
                        rows={4}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Tags</span>
                        <span className={styles.fieldHelper}>Categories and labels for organization.</span>
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
                              placeholder="Add tag..."
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
                        <span className={styles.fieldLabel}>Image Gallery</span>
                        <span className={styles.fieldHelper}>
                          Upload images for this character. These are personal to your account.
                        </span>
                      </div>

                      <div className={styles.galleryGrid}>
                        {galleryItems.map((item) => (
                          <div key={item.id} className={styles.galleryItem}>
                            <LazyImage
                              src={characterGalleryApi.smallUrl(item.image_id)}
                              alt={item.caption || 'Gallery image'}
                              className={styles.galleryThumb}
                              fallback={<div className={styles.galleryThumbPlaceholder} />}
                            />
                            <button
                              type="button"
                              className={styles.galleryRemoveBtn}
                              onClick={() => handleGalleryRemove(item.id)}
                              title="Remove from gallery"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}

                        <button
                          type="button"
                          className={styles.galleryAddBtn}
                          onClick={() => galleryFileRef.current?.click()}
                          disabled={galleryUploading}
                        >
                          <ImagePlus size={20} />
                          <span>{galleryUploading ? 'Uploading...' : 'Add Image'}</span>
                        </button>
                      </div>

                      <input
                        ref={galleryFileRef}
                        type="file"
                        accept="image/*"
                        className={styles.hiddenInput}
                        onChange={handleGalleryUpload}
                      />

                      {embeddedImageCount > 0 && (
                        <div className={styles.galleryExtract}>
                          <Download size={14} />
                          <div className={styles.galleryExtractInfo}>
                            <span className={styles.fieldLabel}>Embedded Images</span>
                            <span className={styles.fieldHelper}>
                              {embeddedImageCount} image{embeddedImageCount !== 1 ? 's' : ''} found in character data
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.addBtn}
                            disabled={extracting}
                            onClick={handleGalleryExtract}
                          >
                            {extracting ? 'Importing...' : 'Import All'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'expressions' && character && (
                    <ExpressionEditorTab characterId={character.id} />
                  )}

                  {activeTab === 'advanced' && (
                    <>
                      <div ref={wbFieldGroupRef} className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Attached World Books</span>
                        <span className={styles.fieldHelper}>Used by prompt assembly for world info activation. Attach multiple for richer lore.</span>
                        <div className={styles.charWbHeader}>
                          <button
                            ref={wbAddBtnRef}
                            type="button"
                            className={styles.charWbAddBtn}
                            onClick={openWbPopover}
                          >
                            <Plus size={11} />
                            <span>Add</span>
                            <ChevronDown
                              size={10}
                              className={clsx(styles.chevron, wbPopoverOpen && styles.chevronOpen)}
                            />
                          </button>
                          {wbPopoverOpen && wbPopoverPos && createPortal(
                            <div
                              ref={wbPopoverRef}
                              className={styles.charWbPopover}
                              style={{ top: wbPopoverPos.top, left: wbPopoverPos.left, width: wbPopoverPos.width }}
                            >
                              {worldBooks.length === 0 ? (
                                <div className={styles.charWbPopoverEmpty}>No world books available</div>
                              ) : (
                                worldBooks.map((wb) => {
                                  const isActive = attachedWorldBookIds.includes(wb.id)
                                  return (
                                    <button
                                      key={wb.id}
                                      type="button"
                                      className={clsx(styles.charWbPopoverItem, isActive && styles.charWbPopoverItemActive)}
                                      onClick={() => handleToggleWorldBook(wb.id)}
                                    >
                                      <span className={styles.charWbPopoverCheck}>{isActive ? '\u2713' : ''}</span>
                                      <span className={styles.charWbPopoverName}>{wb.name}</span>
                                    </button>
                                  )
                                })
                              )}
                            </div>,
                            document.body
                          )}
                        </div>
                        {attachedWorldBookIds.length > 0 ? (
                          <div className={styles.charWbPills}>
                            {attachedWorldBookIds.map((id) => {
                              const wb = worldBooks.find((b) => b.id === id)
                              return (
                                <span key={id} className={styles.charWbPill}>
                                  <span className={styles.charWbPillName}>{wb?.name || 'Unknown'}</span>
                                  <button
                                    type="button"
                                    className={styles.charWbPillRemove}
                                    onClick={() => handleRemoveWorldBook(id)}
                                    title="Remove world book"
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <span className={styles.charWbHint}>No world books attached</span>
                        )}
                      </div>

                      {character.extensions?.character_book?.entries?.length > 0 && (
                        <div className={styles.lorebookImportSection}>
                          <IconNotebook size={14} />
                          <div className={styles.lorebookImportInfo}>
                            <span className={styles.fieldLabel}>Embedded Lorebook</span>
                            <span className={styles.fieldHelper}>
                              {character.extensions.character_book.entries.length} entries found in character card
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
                                  mutateExtensions((ext) => {
                                    const currentIds = getCharacterWorldBookIds(ext)
                                    return setCharacterWorldBookIds(ext, [...currentIds, res.world_book.id])
                                  }, true)
                                  setLorebookResult(`Imported ${res.entry_count} entries into "${res.world_book.name}" and attached it`)
                                } catch {
                                  setLorebookImporting(false)
                                }
                              }}
                            >
                              {lorebookImporting ? 'Importing...' : 'Import Lorebook'}
                            </button>
                          )}
                        </div>
                      )}
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Character-Bound Regex Scripts</span>
                        <span className={styles.fieldHelper}>
                          Regex scripts attached to this character. These will be bundled with .charx exports.
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
                                  title="Unbind from character (make global)"
                                  onClick={() => handleUnbindRegex(s.id)}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {(() => {
                          const unboundGlobals = allRegexScripts.filter(
                            (s) => s.scope === 'global' && !boundRegexScripts.some((b) => b.id === s.id)
                          )
                          if (unboundGlobals.length === 0 && boundRegexScripts.length === 0) {
                            return (
                              <span className={styles.fieldHelper}>
                                No regex scripts found. Create one in the Regex panel first.
                              </span>
                            )
                          }
                          if (unboundGlobals.length === 0) return null
                          return (
                            <select
                              className={styles.fieldInput}
                              value=""
                              onChange={(e) => {
                                if (e.target.value) handleBindRegex(e.target.value)
                              }}
                            >
                              <option value="">Bind a global regex to this character...</option>
                              {unboundGlobals.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.target})
                                </option>
                              ))}
                            </select>
                          )
                        })()}
                      </div>

                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Extensions (JSON)</span>
                        <span className={styles.fieldHelper}>
                          Raw JSON data for character extensions and custom fields.
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

    {showDeleteConfirm && (
      <ConfirmationModal
        isOpen={true}
        title="Delete Character"
        message={`Delete "${character?.name || 'this character'}" permanently? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
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
