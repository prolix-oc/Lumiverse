import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Plus, Trash2, Upload, Search, FileText, RefreshCw, Globe, User, MessageSquare, X, ChevronDown, Check, Combine, ArrowLeft, Save } from 'lucide-react'
import { useStore } from '@/store'
import { databankApi } from '@/api/databank'
import { settingsApi } from '@/api/settings'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import NumericInput from '@/components/shared/NumericInput'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Toggle } from '@/components/shared/Toggle'
import type { Databank, DatabankDocument } from '@/api/databank'
import type { DatabankSettings } from '@/types/databank-settings'
import {
  getContextDatabankBindings,
  isAutomaticallyActiveForContext,
} from './databankActivation'
import styles from './DatabankPanel.module.css'

type Scope = 'global' | 'character' | 'chat'

const DEFAULT_DATABANK_SETTINGS: DatabankSettings = {
  chunkTargetTokens: 800,
  chunkMaxTokens: 1600,
  chunkOverlapTokens: 120,
  retrievalTopK: 4,
}

function normalizeDatabankSettings(value: unknown): DatabankSettings {
  const raw = (value && typeof value === 'object') ? value as Partial<DatabankSettings> : {}
  const target = Math.min(2000, Math.max(200, Math.floor(raw.chunkTargetTokens ?? DEFAULT_DATABANK_SETTINGS.chunkTargetTokens)))
  const max = Math.min(4000, Math.max(target, Math.floor(raw.chunkMaxTokens ?? DEFAULT_DATABANK_SETTINGS.chunkMaxTokens)))
  const overlap = Math.min(500, Math.max(0, Math.floor(raw.chunkOverlapTokens ?? DEFAULT_DATABANK_SETTINGS.chunkOverlapTokens)))
  const retrievalTopK = Math.min(20, Math.max(1, Math.floor(raw.retrievalTopK ?? DEFAULT_DATABANK_SETTINGS.retrievalTopK)))
  return { chunkTargetTokens: target, chunkMaxTokens: max, chunkOverlapTokens: overlap, retrievalTopK }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function StatusBadge({ status }: { status: DatabankDocument['status'] }) {
  const { t } = useTranslation('panels')
  const cls = {
    pending: styles.statusPending,
    processing: styles.statusProcessing,
    ready: styles.statusReady,
    error: styles.statusError,
  }[status]
  return <span className={`${styles.statusBadge} ${cls}`}>{t(`databankPanel.status.${status}`)}</span>
}

function scopeLabel(scope: string, t: (key: string) => string): string {
  if (scope === 'global') return t('databankPanel.scopeGlobal')
  if (scope === 'character') return t('databankPanel.scopeCharacter')
  if (scope === 'chat') return t('databankPanel.scopeChat')
  return scope
}

function DocumentNameInput({
  name,
  onRename,
  renameTitle,
}: {
  name: string
  onRename: (next: string) => void
  renameTitle: string
}) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(name)
  const focusedNameRef = useRef(name)
  const edited = focused && draft !== focusedNameRef.current
  return (
    <input
      className={styles.docNameInput}
      value={edited ? draft : name}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => {
        focusedNameRef.current = name
        setDraft(name)
        setFocused(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        const val = draft.trim()
        if (val && val !== focusedNameRef.current) onRename(val)
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      title={renameTitle}
    />
  )
}


export default function DatabankPanel() {
  const { t } = useTranslation('panels')
  const {
    databanks, databankDocuments, selectedDatabankId, databankScopeFilter,
    setDatabanks, addDatabank, removeDatabank, updateDatabank: updateBankStore,
    setSelectedDatabankId, setDatabankScopeFilter,
    setDatabankDocuments, addDatabankDocument, removeDatabankDocument, updateDatabankDocument,
  } = useStore()

  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  // Monotonic store signal raised by the singleton WS dispatcher whenever a
  // native Databank mutation or authenticated reconnect requires fresh data.
  const databankRevision = useStore((s) => s.databankRevision)

  const [docSearch, setDocSearch] = useState('')
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const banksRequestRef = useRef(0)
  const contentRequestRef = useRef(0)
  const editingDocIdRef = useRef<string | null>(null)
  const editingDirtyRef = useRef(false)
  const selectedDatabankIdRef = useRef<string | null>(null)
  const pendingContextResetRef = useRef(false)
  const docsRequestRef = useRef(0)


  // ── Document editor ──
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingContent, setEditingContent] = useState('')
  const [editingDirty, setEditingDirty] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  editingDocIdRef.current = editingDocId
  editingDirtyRef.current = editingDirty
  selectedDatabankIdRef.current = selectedDatabankId

  const closeDocEditor = useCallback(() => {
    contentRequestRef.current += 1
    editingDocIdRef.current = null
    editingDirtyRef.current = false
    setEditingDocId(null)
    setEditingContent('')
    setEditingName('')
    setEditingDirty(false)
    setEditorError(null)
    setEditorLoading(false)
    setDiscardConfirmOpen(false)
  }, [])

  const flushPendingContextReset = useCallback(() => {
    if (!pendingContextResetRef.current) return
    pendingContextResetRef.current = false
    docsRequestRef.current += 1
    setSelectedDatabankId(null)
    setDatabankDocuments([])
  }, [setSelectedDatabankId, setDatabankDocuments])

  const settlePendingContextReset = useCallback(() => {
    pendingContextResetRef.current = false
    setDiscardConfirmOpen(false)
  }, [])



  const loadEditorContent = useCallback(async (docId: string, bankId: string) => {
    const requestId = ++contentRequestRef.current
    try {
      const result = await databankApi.getDocumentContent(bankId, docId)
      if (requestId !== contentRequestRef.current) return
      if (editingDocIdRef.current !== docId) return
      if (editingDirtyRef.current) return
      setEditingContent(result.content ?? '')
    } catch (e: unknown) {
      if (requestId !== contentRequestRef.current) return
      if (editingDocIdRef.current !== docId) return
      const err = e as { body?: { error?: string }; message?: string }
      setEditorError(err.body?.error || err.message || t('databankPanel.loadDocFailed'))
    }
  }, [t])


  // ── Cross-reference: all user databanks (for selectors) ──
  const [allBanks, setAllBanks] = useState<Databank[]>([])
  const [charDatabankIds, setCharDatabankIds] = useState<string[]>([])
  const [charExtensions, setCharExtensions] = useState<Record<string, any>>({})
  const [chatDatabankIds, setChatDatabankIds] = useState<string[]>([])
  const [chatMetadata, setChatMetadata] = useState<Record<string, any>>({})
  const [charPickerOpen, setCharPickerOpen] = useState(false)
  const [chatPickerOpen, setChatPickerOpen] = useState(false)
  const [databankSettings, setDatabankSettings] = useState<DatabankSettings>(DEFAULT_DATABANK_SETTINGS)
  const [databankSettingsLoading, setDatabankSettingsLoading] = useState(true)
  const [databankSettingsSaving, setDatabankSettingsSaving] = useState(false)
  const [databankSettingsStatus, setDatabankSettingsStatus] = useState<string | null>(null)
  const [reprocessingAll, setReprocessingAll] = useState(false)
  const [bankEnabledSaving, setBankEnabledSaving] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const databankSettingsLoadedRef = useRef(false)
  const databankSettingsDirtyRef = useRef(false)

  // Load all banks for cross-reference selectors
  useEffect(() => {
    databankApi.list({ limit: 200 }).then((r) => setAllBanks(r.data)).catch(() => {})
  }, [databanks]) // refresh when databanks change (create/delete)

  useEffect(() => {
    let cancelled = false
    setDatabankSettingsLoading(true)
    settingsApi.get('databankSettings')
      .then((row) => {
        if (cancelled) return
        setDatabankSettings(normalizeDatabankSettings(row.value))
        databankSettingsLoadedRef.current = true
      })
      .catch(() => {
        if (cancelled) return
        setDatabankSettings(DEFAULT_DATABANK_SETTINGS)
        databankSettingsLoadedRef.current = true
      })
      .finally(() => {
        if (!cancelled) setDatabankSettingsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
  }, [])

  useEffect(() => {
    if (!databankSettingsLoadedRef.current || !databankSettingsDirtyRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setDatabankSettingsSaving(true)
    setDatabankSettingsStatus(t('databankPanel.savingSettings'))
    saveTimerRef.current = setTimeout(async () => {
      try {
        await settingsApi.put('databankSettings', databankSettings)
        databankSettingsDirtyRef.current = false
        setDatabankSettingsStatus(t('databankPanel.settingsSaved'))
      } catch (e: any) {
        setDatabankSettingsStatus(e?.body?.error || e?.message || t('databankPanel.settingsSaveFailed'))
      } finally {
        setDatabankSettingsSaving(false)
      }
    }, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [databankSettings, t])

  // Load character databank bindings
  useEffect(() => {
    if (!activeCharacterId) { setCharDatabankIds([]); setCharExtensions({}); return }
    charactersApi.get(activeCharacterId).then((c: { extensions?: Record<string, unknown> }) => {
      const ext = c.extensions || {}
      setCharExtensions(ext)
      const ids = Array.isArray(ext.databank_ids) ? ext.databank_ids.filter((id: unknown) => typeof id === 'string') : []
      setCharDatabankIds(ids)
    }).catch(() => {})
  }, [activeCharacterId])

  // Load chat databank bindings
  useEffect(() => {
    if (!activeChatId) { setChatDatabankIds([]); setChatMetadata({}); return }
    chatsApi.get(activeChatId).then((chat: { metadata?: Record<string, unknown> }) => {
      const meta = chat.metadata || {}
      setChatMetadata(meta)
      setChatDatabankIds(Array.isArray(meta.chat_databank_ids) ? meta.chat_databank_ids.filter((id: unknown) => typeof id === 'string') : [])
    }).catch(() => {})
  }, [activeChatId])

  const toggleCharBank = useCallback((id: string) => {
    if (!activeCharacterId) return
    const next = charDatabankIds.includes(id)
      ? charDatabankIds.filter((x) => x !== id)
      : [...charDatabankIds, id]
    setCharDatabankIds(next)
    const ext = { ...charExtensions, databank_ids: next }
    setCharExtensions(ext)
    charactersApi.update(activeCharacterId, { extensions: ext }).catch(() => {})
  }, [activeCharacterId, charDatabankIds, charExtensions])

  const toggleChatBank = useCallback((id: string) => {
    if (!activeChatId) return
    const next = chatDatabankIds.includes(id)
      ? chatDatabankIds.filter((x) => x !== id)
      : [...chatDatabankIds, id]
    setChatDatabankIds(next)
    const meta = { ...chatMetadata, chat_databank_ids: next }
    setChatMetadata(meta)
    chatsApi.patchMetadata(activeChatId, { chat_databank_ids: next }).catch(() => {})
  }, [activeChatId, chatDatabankIds, chatMetadata])

  // ── Load banks on mount and scope change ──
  const loadBanks = useCallback(async () => {
    const requestId = ++banksRequestRef.current
    try {
      const params: Record<string, string> = { scope: databankScopeFilter }
      if (databankScopeFilter === 'character' && activeCharacterId) {
        params.scope_id = activeCharacterId
      }
      if (databankScopeFilter === 'chat' && activeChatId) {
        params.scope_id = activeChatId
      }
      const result = await databankApi.list(params)
      if (requestId === banksRequestRef.current) setDatabanks(result.data)
    } catch {
      if (requestId === banksRequestRef.current) setDatabanks([])
    }
  }, [databankScopeFilter, activeCharacterId, activeChatId, setDatabanks])


  useEffect(() => {
    void loadBanks()
    return () => { banksRequestRef.current += 1 }
  }, [loadBanks, databankRevision])

  // A selected bank belongs to the scope/context in which it was chosen. Clear
  // it before rendering a different scope so stale documents and actions from
  // the previous bank cannot appear under an empty selector.
  useEffect(() => {
    if (editingDirtyRef.current && editingDocIdRef.current) {
      pendingContextResetRef.current = true
      setDiscardConfirmOpen(true)
      return
    }
    pendingContextResetRef.current = false
    docsRequestRef.current += 1
    contentRequestRef.current += 1
    setSelectedDatabankId(null)
    setDatabankDocuments([])
    closeDocEditor()
  }, [databankScopeFilter, activeCharacterId, activeChatId, setSelectedDatabankId, setDatabankDocuments, closeDocEditor])

  // DATABANK_DELETED removes the bank and nulls selection. That is not
  // user-clean navigation, which closes the editor in the same turn.
  useEffect(() => {
    if (!editingDocId || selectedDatabankId) return
    docsRequestRef.current += 1
    closeDocEditor()
    setError(t('databankPanel.remoteDatabankRemoved'))
  }, [editingDocId, selectedDatabankId, closeDocEditor, t])


  // ── Load documents when bank selection changes ──
  const loadDocs = useCallback(async () => {
    const requestId = ++docsRequestRef.current
    if (!selectedDatabankId) {
      setDatabankDocuments([])
      return
    }
    try {
      const result = await databankApi.listDocuments(selectedDatabankId, { limit: 1000 })
      if (requestId !== docsRequestRef.current) return
      setDatabankDocuments(result.data)
      const listComplete = result.offset + result.data.length >= result.total
      const openId = editingDocIdRef.current
      if (listComplete && openId && !result.data.some((doc) => doc.id === openId)) {
        closeDocEditor()
        setError(t('databankPanel.remoteDocumentRemoved'))
      }
    } catch {
      if (requestId === docsRequestRef.current && !editingDocIdRef.current) setDatabankDocuments([])
    }
  }, [selectedDatabankId, setDatabankDocuments, closeDocEditor, t])


  useEffect(() => {
    void loadDocs()
    return () => { docsRequestRef.current += 1 }
  }, [loadDocs, databankRevision])

  useEffect(() => {
    if (!editingDocId) return
    const live = databankDocuments.find((doc) => doc.id === editingDocId)
    if (live) setEditingName(live.name)
  }, [databankDocuments, editingDocId])

  useEffect(() => {
    const docId = editingDocIdRef.current
    const bankId = selectedDatabankIdRef.current
    if (!docId || !bankId || editingDirtyRef.current) return
    void loadEditorContent(docId, bankId)
  }, [databankRevision, loadEditorContent])




  // ── Poll for document status updates ──
  useEffect(() => {
    const hasProcessing = databankDocuments.some((d) => d.status === 'pending' || d.status === 'processing')
    if (hasProcessing && selectedDatabankId) {
      pollRef.current = setInterval(async () => {
        try {
          const result = await databankApi.listDocuments(selectedDatabankId, { limit: 1000 })
          setDatabankDocuments(result.data)
          const stillProcessing = result.data.some((d) => d.status === 'pending' || d.status === 'processing')
          if (!stillProcessing && pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        } catch { /* ignore */ }
      }, 3000)
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [databankDocuments, selectedDatabankId, setDatabankDocuments])

  // ── Create bank ──
  const handleCreate = useCallback(async () => {
    try {
      const scopeId = databankScopeFilter === 'character' ? activeCharacterId
        : databankScopeFilter === 'chat' ? activeChatId
        : undefined
      const bank = await databankApi.create({
        name: t('databankPanel.newDatabank'),
        scope: databankScopeFilter,
        scope_id: scopeId || undefined,
      })
      addDatabank(bank)
      setSelectedDatabankId(bank.id)
    } catch (e: any) {
      setError(e.message)
    }
  }, [databankScopeFilter, activeCharacterId, activeChatId, addDatabank, setSelectedDatabankId, t])

  // ── Delete bank ──
  const handleDeleteBank = useCallback(async () => {
    if (!selectedDatabankId) return
    try {
      await databankApi.delete(selectedDatabankId)
      removeDatabank(selectedDatabankId)
      setSelectedDatabankId(null)
    } catch (e: any) {
      setError(e.message)
    }
  }, [selectedDatabankId, removeDatabank, setSelectedDatabankId])

  // ── Update bank details ──
  const handleBankUpdate = useCallback(async (field: 'name' | 'description', value: string) => {
    if (!selectedDatabankId) return
    try {
      const updated = await databankApi.update(selectedDatabankId, { [field]: value })
      updateBankStore(selectedDatabankId, { [field]: updated[field] })
      setAllBanks((current) => current.map((bank) => bank.id === updated.id ? updated : bank))
    } catch { /* ignore */ }
  }, [selectedDatabankId, updateBankStore])

  const handleBankEnabledChange = useCallback(async (enabled: boolean) => {
    if (!selectedDatabankId) return
    setError(null)
    setBankEnabledSaving(true)
    try {
      const updated = await databankApi.update(selectedDatabankId, { enabled })
      updateBankStore(selectedDatabankId, { enabled: updated.enabled })
      setAllBanks((current) => current.map((bank) => bank.id === updated.id ? updated : bank))
    } catch (e: any) {
      setError(e?.body?.error || e?.message || t('databankPanel.enabledUpdateFailed'))
    } finally {
      setBankEnabledSaving(false)
    }
  }, [selectedDatabankId, updateBankStore, t])

  const handleDatabankSettingsUpdate = useCallback((patch: Partial<DatabankSettings>) => {
    databankSettingsDirtyRef.current = true
    setDatabankSettings((current) => normalizeDatabankSettings({ ...current, ...patch }))
  }, [])

  // ── Upload files ──
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!selectedDatabankId) return
    setError(null)
    setLoading(true)
    try {
      for (const file of Array.from(files)) {
        const doc = await databankApi.uploadDocument(selectedDatabankId, file)
        addDatabankDocument(doc)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [selectedDatabankId, addDatabankDocument])

  // ── Delete document ──
  const handleDeleteDoc = useCallback(async (docId: string) => {
    if (!selectedDatabankId) return
    try {
      await databankApi.deleteDocument(selectedDatabankId, docId)
      removeDatabankDocument(docId)
    } catch (e: any) {
      setError(e.message)
    }
  }, [selectedDatabankId, removeDatabankDocument])

  const handleReprocessDoc = useCallback(async (docId: string) => {
    if (!selectedDatabankId) return
    try {
      updateDatabankDocument(docId, { status: 'pending', errorMessage: null })
      await databankApi.reprocessDocument(selectedDatabankId, docId)
    } catch (e: any) {
      setError(e?.body?.error || e?.message || t('databankPanel.reprocessDocFailed'))
      await loadDocs()
    }
  }, [selectedDatabankId, updateDatabankDocument, loadDocs, t])

  const handleReprocessAll = useCallback(async () => {
    const docsToReprocess = databankDocuments.filter((doc) => doc.status !== 'pending' && doc.status !== 'processing')
    if (!selectedDatabankId || docsToReprocess.length === 0) return
    setError(null)
    setReprocessingAll(true)
    try {
      const docIds = docsToReprocess.map((doc) => doc.id)
      docIds.forEach((docId) => updateDatabankDocument(docId, { status: 'pending', errorMessage: null }))
      for (const docId of docIds) {
        await databankApi.reprocessDocument(selectedDatabankId, docId)
      }
    } catch (e: any) {
      setError(e?.body?.error || e?.message || t('databankPanel.reprocessAllFailed'))
      await loadDocs()
    } finally {
      setReprocessingAll(false)
    }
  }, [selectedDatabankId, databankDocuments, updateDatabankDocument, loadDocs, t])

  // ── Fuse ──
  const [fusePickerOpen, setFusePickerOpen] = useState(false)
  const [fusing, setFusing] = useState(false)
  const [fuseStatus, setFuseStatus] = useState<string | null>(null)
  const [pendingFuse, setPendingFuse] = useState<{ sourceBankId: string; sourceName: string; sourceCount: number } | null>(null)

  const requestFuse = useCallback((sourceBankId: string, sourceName: string, sourceCount: number) => {
    if (!selectedDatabankId) return
    setFusePickerOpen(false)
    setPendingFuse({ sourceBankId, sourceName, sourceCount })
  }, [selectedDatabankId])

  const confirmFuse = useCallback(async () => {
    if (!selectedDatabankId || !pendingFuse) return
    setError(null)
    setFuseStatus(null)
    setFusing(true)
    try {
      const result = await databankApi.fuse(selectedDatabankId, pendingFuse.sourceBankId)
      removeDatabank(pendingFuse.sourceBankId)
      updateBankStore(selectedDatabankId, {
        name: result.databank.name,
        description: result.databank.description,
        documentCount: result.databank.documentCount,
      })
      setFuseStatus(t('databankPanel.fuseResult', { moved: result.moved, skipped: result.skipped }))
      // Refresh document list and the cross-reference bank list
      await loadDocs()
      databankApi.list({ limit: 200 }).then((r) => setAllBanks(r.data)).catch(() => {})
      setPendingFuse(null)
    } catch (e: any) {
      setError(e?.body?.error || e?.message || t('databankPanel.fuseFailed'))
    } finally {
      setFusing(false)
    }
  }, [selectedDatabankId, pendingFuse, removeDatabank, updateBankStore, loadDocs, t])

  // ── Scrape URL ──
  const [scrapeUrl, setScrapeUrl] = useState('')
  const [scraping, setScraping] = useState(false)

  const handleScrape = useCallback(async () => {
    if (!selectedDatabankId || !scrapeUrl.trim()) return
    setError(null)
    setScraping(true)
    try {
      const doc = await databankApi.scrapeUrl(selectedDatabankId, scrapeUrl.trim())
      addDatabankDocument(doc)
      setScrapeUrl('')
    } catch (e: any) {
      setError(e.body?.error || e.message || t('databankPanel.scrapeFailed'))
    } finally {
      setScraping(false)
    }
  }, [selectedDatabankId, scrapeUrl, addDatabankDocument, t])

  const handleOpenDocEditor = useCallback(async (doc: DatabankDocument) => {
    if (!selectedDatabankId) return
    editingDocIdRef.current = doc.id
    editingDirtyRef.current = false
    setEditingDocId(doc.id)
    setEditingName(doc.name)
    setEditingContent('')
    setEditingDirty(false)
    setEditorError(null)
    setEditorLoading(true)
    try {
      await loadEditorContent(doc.id, selectedDatabankId)
    } finally {
      if (editingDocIdRef.current === doc.id) setEditorLoading(false)
    }
  }, [selectedDatabankId, loadEditorContent])

  const handleCloseDocEditor = useCallback(() => {
    if (editingDirty) {
      setDiscardConfirmOpen(true)
      return
    }
    closeDocEditor()
    flushPendingContextReset()
  }, [editingDirty, closeDocEditor, flushPendingContextReset])

  const handleSaveDocEditor = useCallback(async () => {
    if (!selectedDatabankId || !editingDocId) return
    setEditorError(null)
    setEditorSaving(true)
    try {
      const updated = await databankApi.updateDocumentContent(selectedDatabankId, editingDocId, editingContent)
      updateDatabankDocument(updated.id, {
        fileSize: updated.fileSize,
        contentHash: updated.contentHash,
        mimeType: updated.mimeType,
        filePath: updated.filePath,
        status: updated.status,
        errorMessage: updated.errorMessage,
        totalChunks: updated.totalChunks,
        updatedAt: updated.updatedAt,
      })
      setEditingDirty(false)
      closeDocEditor()
      flushPendingContextReset()
    } catch (e: unknown) {
      const err = e as { body?: { error?: string }; message?: string }
      setEditorError(err.body?.error || err.message || t('databankPanel.saveDocFailed'))
    } finally {
      setEditorSaving(false)
    }
  }, [selectedDatabankId, editingDocId, editingContent, updateDatabankDocument, t, closeDocEditor, flushPendingContextReset])


  // ── Rename document ──
  const handleRenameDoc = useCallback(async (docId: string, newName: string) => {
    if (!selectedDatabankId || !newName.trim()) return
    try {
      const updated = await databankApi.renameDocument(selectedDatabankId, docId, newName.trim())
      updateDatabankDocument(docId, { name: updated.name, slug: updated.slug })
    } catch { /* ignore */ }
  }, [selectedDatabankId, updateDatabankDocument])

  // ── Drag and drop ──
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true) }, [])
  const handleDragLeave = useCallback(() => setDragging(false), [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const selectedBank = databanks.find((b) => b.id === selectedDatabankId)
  const filteredDocs = docSearch
    ? databankDocuments.filter((d) => d.name.toLowerCase().includes(docSearch.toLowerCase()))
    : databankDocuments
  const reprocessableDocs = databankDocuments.filter((doc) => doc.status !== 'pending' && doc.status !== 'processing')

  const characterBindings = getContextDatabankBindings(
    allBanks,
    'character',
    activeCharacterId,
    charDatabankIds,
  )
  const chatBindings = getContextDatabankBindings(
    allBanks,
    'chat',
    activeChatId,
    chatDatabankIds,
  )

  // ── Document editor view ──
  if (editingDocId) {
    return (
      <div className={styles.panel}>
        <div className={styles.editorHeader}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleCloseDocEditor}
            title={t('databankPanel.backToDocuments')}
          >
            <ArrowLeft size={14} />
          </button>
          <div className={styles.editorTitleGroup}>
            <div className={styles.editorTitle}>{editingName || t('databankPanel.untitledDocument')}</div>
            <div className={styles.editorSubtitle}>
              {editorLoading ? t('databankPanel.loadingContent') : editingDirty ? t('databankPanel.unsavedChanges') : t('databankPanel.editsRechunkHint')}
            </div>
          </div>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleSaveDocEditor}
            disabled={editorSaving || editorLoading || !editingDirty}
            title={t('databankPanel.saveAndReprocess')}
          >
            <Save size={13} />
            <span>{editorSaving ? t('databankPanel.saving') : t('databankPanel.save')}</span>
          </button>
        </div>
        {editorError && (
          <div style={{ color: 'var(--lumiverse-danger)', fontSize: 11, padding: '0 4px' }}>{editorError}</div>
        )}
        <div className={styles.editorBody}>
          {editorLoading ? (
            <div className={styles.emptyState}>
              <RefreshCw size={20} className={`${styles.emptyIcon} ${styles.spin}`} />
              <div className={styles.emptyText}>{t('databankPanel.loadingDocument')}</div>
            </div>
          ) : (
            <ExpandableTextarea
              className={styles.editorTextarea}
              value={editingContent}
              onChange={(value) => {
                editingDirtyRef.current = true
                setEditingContent(value)
                setEditingDirty(true)
              }}
              title={editingName || t('databankPanel.document')}
              placeholder={t('databankPanel.editContentPlaceholder')}
              spellCheck={false}
              markdownOnly
            />
          )}
        </div>

        <ConfirmationModal
          isOpen={discardConfirmOpen}
          onConfirm={() => {
            closeDocEditor()
            flushPendingContextReset()
          }}
          onCancel={settlePendingContextReset}
          title={t('databankPanel.discardTitle')}
          message={t('databankPanel.discardMessage')}
          variant="warning"
          confirmText={t('databankPanel.discard')}
          cancelText={t('databankPanel.keepEditing')}
        />
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {/* Cross-reference: Character attachments */}
      {activeCharacterId && (
        <div className={styles.attachSection}>
          <div className={styles.attachHeader}>
            <User size={12} className={styles.attachIcon} />
            <span className={styles.attachLabel}>
              {t('databankPanel.characterDatabanks', { name: characters.find(c => c.id === activeCharacterId)?.name || t('databankPanel.character') })}
            </span>
            <button
              type="button"
              className={styles.attachAddBtn}
              onClick={() => setCharPickerOpen((p) => !p)}
            >
              <Plus size={11} />
              <span>{t('databankPanel.attach')}</span>
              <ChevronDown size={10} className={charPickerOpen ? styles.chevronOpen : ''} />
            </button>
          </div>
          {charPickerOpen && (
            <div className={styles.attachPicker}>
              {allBanks.length === 0 ? (
                <div className={styles.attachPickerEmpty}>{t('databankPanel.noDatabanksAvailable')}</div>
              ) : (
                allBanks.map((b) => {
                  const isAttached = charDatabankIds.includes(b.id)
                  const isAutomatic = isAutomaticallyActiveForContext(b, 'character', activeCharacterId)
                  const isActive = b.enabled && (isAttached || isAutomatic)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`${styles.attachPickerItem} ${isActive ? styles.attachPickerItemActive : ''}`}
                      onClick={() => toggleCharBank(b.id)}
                      disabled={isAutomatic}
                      title={isAutomatic ? t('databankPanel.automaticScopeHint') : undefined}
                    >
                      <span className={styles.attachCheck}>{isActive ? <Check size={11} /> : null}</span>
                      <span className={styles.attachPickerName}>{b.name}</span>
                      <span className={styles.attachPickerScope}>
                        {!b.enabled
                          ? t('databankPanel.disabled')
                          : isAutomatic
                            ? t('databankPanel.automatic')
                            : scopeLabel(b.scope, t)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
          {characterBindings.length > 0 && (
            <div className={styles.attachPills}>
              {characterBindings.map(({ bank, automatic }) => (
                <span key={bank.id} className={`${styles.attachPill} ${!bank.enabled ? styles.attachPillDisabled : ''}`}>
                  <span>{bank.name}</span>
                  <span className={styles.attachPillState}>
                    {bank.enabled
                      ? automatic ? t('databankPanel.automatic') : t('databankPanel.attached')
                      : t('databankPanel.disabled')}
                  </span>
                  {!automatic && (
                    <button type="button" className={styles.attachPillRemove} onClick={() => toggleCharBank(bank.id)}>
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {characterBindings.length === 0 && !charPickerOpen && (
            <span className={styles.attachHint}>{t('databankPanel.noCharacterAttached')}</span>
          )}
        </div>
      )}

      {/* Cross-reference: Chat attachments */}
      {activeChatId && (
        <div className={styles.attachSection}>
          <div className={styles.attachHeader}>
            <MessageSquare size={12} className={styles.attachIcon} />
            <span className={styles.attachLabel}>{t('databankPanel.thisChat')}</span>
            <button
              type="button"
              className={styles.attachAddBtn}
              onClick={() => setChatPickerOpen((p) => !p)}
            >
              <Plus size={11} />
              <span>{t('databankPanel.attach')}</span>
              <ChevronDown size={10} className={chatPickerOpen ? styles.chevronOpen : ''} />
            </button>
          </div>
          {chatPickerOpen && (
            <div className={styles.attachPicker}>
              {allBanks.length === 0 ? (
                <div className={styles.attachPickerEmpty}>{t('databankPanel.noDatabanksAvailable')}</div>
              ) : (
                allBanks.map((b) => {
                  const isAttached = chatDatabankIds.includes(b.id)
                  const isAutomatic = isAutomaticallyActiveForContext(b, 'chat', activeChatId)
                  const isActive = b.enabled && (isAttached || isAutomatic)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`${styles.attachPickerItem} ${isActive ? styles.attachPickerItemActive : ''}`}
                      onClick={() => toggleChatBank(b.id)}
                      disabled={isAutomatic}
                      title={isAutomatic ? t('databankPanel.automaticScopeHint') : undefined}
                    >
                      <span className={styles.attachCheck}>{isActive ? <Check size={11} /> : null}</span>
                      <span className={styles.attachPickerName}>{b.name}</span>
                      <span className={styles.attachPickerScope}>
                        {!b.enabled
                          ? t('databankPanel.disabled')
                          : isAutomatic
                            ? t('databankPanel.automatic')
                            : scopeLabel(b.scope, t)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
          {chatBindings.length > 0 && (
            <div className={styles.attachPills}>
              {chatBindings.map(({ bank, automatic }) => (
                <span key={bank.id} className={`${styles.attachPill} ${!bank.enabled ? styles.attachPillDisabled : ''}`}>
                  <span>{bank.name}</span>
                  <span className={styles.attachPillState}>
                    {bank.enabled
                      ? automatic ? t('databankPanel.automatic') : t('databankPanel.attached')
                      : t('databankPanel.disabled')}
                  </span>
                  {!automatic && (
                    <button type="button" className={styles.attachPillRemove} onClick={() => toggleChatBank(bank.id)}>
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {chatBindings.length === 0 && !chatPickerOpen && (
            <span className={styles.attachHint}>{t('databankPanel.noChatAttached')}</span>
          )}
        </div>
      )}

      {/* Scope Toggle */}
      <div className={styles.scopeToggle}>
        {(['global', 'character', 'chat'] as Scope[]).map((s) => (
          <button
            key={s}
            className={`${styles.scopeBtn} ${databankScopeFilter === s ? styles.scopeBtnActive : ''}`}
            onClick={() => setDatabankScopeFilter(s)}
          >
            {s === 'global' ? t('databankPanel.scopeGlobal') : s === 'character' ? t('databankPanel.scopeCharacter') : t('databankPanel.scopeChat')}
          </button>
        ))}
      </div>

      <div className={styles.bankDetails}>
        <div className={styles.settingsHeaderRow}>
          <div>
            <div className={styles.settingsTitle}>{t('databankPanel.retrievalTitle')}</div>
            <div className={styles.settingsHint}>{t('databankPanel.retrievalHint')}</div>
          </div>
          <span className={styles.settingsStatus}>
            {databankSettingsLoading ? t('databankPanel.loading') : databankSettingsSaving ? t('databankPanel.saving') : databankSettingsStatus ?? t('databankPanel.ready')}
          </span>
        </div>
        <div className={styles.settingsGrid}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.chunkTargetTokens')}</label>
            <NumericInput
              className={styles.fieldInput}
              min={200}
              max={2000}
              value={databankSettings.chunkTargetTokens}
              disabled={databankSettingsLoading}
              integer
              onChange={(value) => handleDatabankSettingsUpdate({ chunkTargetTokens: value ?? DEFAULT_DATABANK_SETTINGS.chunkTargetTokens })}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.chunkMaxTokens')}</label>
            <NumericInput
              className={styles.fieldInput}
              min={200}
              max={4000}
              value={databankSettings.chunkMaxTokens}
              disabled={databankSettingsLoading}
              integer
              onChange={(value) => handleDatabankSettingsUpdate({ chunkMaxTokens: value ?? DEFAULT_DATABANK_SETTINGS.chunkMaxTokens })}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.chunkOverlapTokens')}</label>
            <NumericInput
              className={styles.fieldInput}
              min={0}
              max={500}
              value={databankSettings.chunkOverlapTokens}
              disabled={databankSettingsLoading}
              integer
              onChange={(value) => handleDatabankSettingsUpdate({ chunkOverlapTokens: value ?? 0 })}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.retrievedChunks')}</label>
            <NumericInput
              className={styles.fieldInput}
              min={1}
              max={20}
              value={databankSettings.retrievalTopK}
              disabled={databankSettingsLoading}
              integer
              onChange={(value) => handleDatabankSettingsUpdate({ retrievalTopK: value ?? DEFAULT_DATABANK_SETTINGS.retrievalTopK })}
            />
          </div>
        </div>
      </div>

      {/* Character picker for character scope */}
      {databankScopeFilter === 'character' && (
        <select
          className={`${styles.bankSelect} ${styles.scopeCharPicker}`}
          value={activeCharacterId || ''}
          disabled
          title={t('databankPanel.autoScopedCharacter')}
        >
          <option value="">{activeCharacterId ? characters.find(c => c.id === activeCharacterId)?.name || t('databankPanel.activeCharacter') : t('databankPanel.noCharacterActive')}</option>
        </select>
      )}

      {/* Chat scope hint */}
      {databankScopeFilter === 'chat' && !activeChatId && (
        <div className={styles.emptyHint}>{t('databankPanel.openChatForBanks')}</div>
      )}

      {/* Bank selector bar */}
      <div className={styles.topBar}>
        <select
          className={styles.bankSelect}
          value={selectedDatabankId || ''}
          onChange={(e) => setSelectedDatabankId(e.target.value || null)}
        >
          <option value="">{t('databankPanel.selectDatabank')}</option>
          {databanks.map((b) => (
            <option key={b.id} value={b.id}>{b.name} ({b.documentCount ?? 0})</option>
          ))}
        </select>
        <button className={styles.actionBtn} onClick={handleCreate} title={t('databankPanel.createDatabank')}>
          <Plus size={14} />
        </button>
        {selectedDatabankId && (
          <>
            <button
              className={styles.actionBtn}
              onClick={() => setFusePickerOpen((p) => !p)}
              title={t('databankPanel.fuseIntoThis')}
              disabled={fusing}
            >
              <Combine size={14} className={fusing ? styles.spin : ''} />
            </button>
            <button className={`${styles.actionBtn} ${styles.deleteBtn}`} onClick={handleDeleteBank} title={t('databankPanel.deleteDatabank')}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>

      {selectedDatabankId && fusePickerOpen && (
        <div className={styles.attachPicker}>
          {(() => {
            const candidates = allBanks.filter((b) => b.id !== selectedDatabankId)
            if (candidates.length === 0) {
              return <div className={styles.attachPickerEmpty}>{t('databankPanel.noOtherToFuse')}</div>
            }
            return (
              <>
                <div className={styles.fusePickerHint}>
                  {t('databankPanel.fusePickerHint', { name: databanks.find((b) => b.id === selectedDatabankId)?.name ?? '' })}
                </div>
                {candidates.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={styles.attachPickerItem}
                    onClick={() => requestFuse(b.id, b.name, b.documentCount ?? 0)}
                    disabled={fusing}
                  >
                    <span className={styles.attachCheck}><Combine size={11} /></span>
                    <span className={styles.attachPickerName}>{b.name}</span>
                    <span className={styles.attachPickerScope}>
                      {t('databankPanel.docCountScope', { count: b.documentCount ?? 0, scope: scopeLabel(b.scope, t) })}
                    </span>
                  </button>
                ))}
              </>
            )
          })()}
        </div>
      )}

      {fuseStatus && <div className={styles.fuseStatus}>{fuseStatus}</div>}
      {error && <div style={{ color: 'var(--lumiverse-danger)', fontSize: 11, padding: '0 4px' }}>{error}</div>}

      {/* Bank details */}
      {selectedBank && (
        <div className={styles.bankDetails}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.name')}</label>
            <input
              className={styles.fieldInput}
              value={selectedBank.name}
              onChange={(e) => {
                updateBankStore(selectedBank.id, { name: e.target.value })
              }}
              onBlur={(e) => handleBankUpdate('name', e.target.value)}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('databankPanel.description')}</label>
            <textarea
              className={styles.fieldInput}
              rows={2}
              value={selectedBank.description}
              onChange={(e) => {
                updateBankStore(selectedBank.id, { description: e.target.value })
              }}
              onBlur={(e) => handleBankUpdate('description', e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={styles.scopeBadge}>{scopeLabel(selectedBank.scope, t)}</span>
            <div className={styles.enableToggle}>
              <Toggle.Switch
                checked={selectedBank.enabled}
                onChange={handleBankEnabledChange}
                size="sm"
                disabled={bankEnabledSaving}
                aria-label={t('databankPanel.enabled')}
                title={t('databankPanel.enabledHint')}
              />
              <span>{selectedBank.enabled ? t('databankPanel.enabled') : t('databankPanel.disabled')}</span>
            </div>
          </div>
          <div className={styles.settingsHint}>{t('databankPanel.enabledHint')}</div>
        </div>
      )}

      {/* Upload Zone */}
      {selectedDatabankId && (
        <>
          <div className={styles.toolbarRow}>
            <button
              className={styles.secondaryBtn}
              onClick={handleReprocessAll}
              disabled={reprocessingAll || reprocessableDocs.length === 0}
              title={t('databankPanel.reprocessAllTitle')}
            >
              <RefreshCw size={13} className={reprocessingAll ? styles.spin : ''} />
              <span>{reprocessingAll ? t('databankPanel.reprocessing') : t('databankPanel.reprocessAll')}</span>
            </button>
            <span className={styles.toolbarHint}>{t('databankPanel.reprocessAllHint')}</span>
          </div>
          <div
            className={`${styles.uploadZone} ${dragging ? styles.uploadZoneDragging : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={24} className={styles.uploadIcon} />
            <span>{loading ? t('databankPanel.uploading') : t('databankPanel.dropFiles')}</span>
            <span className={styles.uploadHint}>.txt, .md, .csv, .json, .xml, .html, .yaml, .log, .rst, .rtf</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rst,.rtf"
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = '' }}
          />
        </>
      )}

      {/* Scrape URL */}
      {selectedDatabankId && (
        <div className={styles.scrapeRow}>
          <Globe size={14} className={styles.docSearchIcon} />
          <input
            className={styles.docSearchInput}
            placeholder={t('databankPanel.scrapeUrlPlaceholder')}
            value={scrapeUrl}
            onChange={(e) => setScrapeUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleScrape() }}
            disabled={scraping}
          />
          <button
            className={styles.actionBtn}
            onClick={handleScrape}
            disabled={scraping || !scrapeUrl.trim()}
            title={t('databankPanel.scrapeWebPage')}
          >
            {scraping ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
          </button>
        </div>
      )}

      {/* Document Search */}
      {selectedDatabankId && databankDocuments.length > 0 && (
        <div className={styles.docSearch}>
          <Search size={14} className={styles.docSearchIcon} />
          <input
            className={styles.docSearchInput}
            placeholder={t('databankPanel.searchDocuments')}
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
          />
        </div>
      )}

      {/* Document List */}
      {selectedDatabankId && (
        <div className={styles.docList}>
          {filteredDocs.map((doc) => (
            <div
              key={doc.id}
              className={styles.docRow}
              onClick={() => handleOpenDocEditor(doc)}
              title={t('databankPanel.openDocument')}
              role="button"
            >
              <FileText size={16} className={styles.docIcon} />
              <div className={styles.docInfo}>
                <DocumentNameInput
                  name={doc.name}
                  onRename={(next) => { void handleRenameDoc(doc.id, next) }}
                  renameTitle={t('databankPanel.clickToRename')}
                />
                <div className={styles.docMeta}>
                  {formatFileSize(doc.fileSize)}
                  {doc.totalChunks > 0 && ` \u00B7 ${t('databankPanel.chunkCount', { count: doc.totalChunks })}`}
                  {doc.slug && <span> &middot; #{doc.slug}</span>}
                  {doc.errorMessage && <span> &middot; {doc.errorMessage}</span>}
                </div>
              </div>
              <div className={styles.docActions}>
                <StatusBadge status={doc.status} />
                <button
                  className={styles.smallActionBtn}
                  onClick={(e) => { e.stopPropagation(); handleReprocessDoc(doc.id) }}
                  title={t('databankPanel.reprocessDocument')}
                  disabled={doc.status === 'pending' || doc.status === 'processing'}
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  className={styles.smallDeleteBtn}
                  onClick={(e) => { e.stopPropagation(); handleDeleteDoc(doc.id) }}
                  title={t('databankPanel.deleteDocument')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty states */}
      {!selectedDatabankId && databanks.length === 0 && (
        <div className={styles.emptyState}>
          <Database size={32} className={styles.emptyIcon} />
          <div className={styles.emptyText}>{t('databankPanel.noDatabanksYet')}</div>
          <div className={styles.emptyHint}>{t('databankPanel.noDatabanksYetHint')}</div>
        </div>
      )}

      {selectedDatabankId && databankDocuments.length === 0 && !loading && (
        <div className={styles.emptyState}>
          <FileText size={24} className={styles.emptyIcon} />
          <div className={styles.emptyText}>{t('databankPanel.noDocuments')}</div>
          <div className={styles.emptyHint}>{t('databankPanel.noDocumentsHint')}</div>
        </div>
      )}

      <ConfirmationModal
        isOpen={!!pendingFuse}
        onConfirm={confirmFuse}
        onCancel={() => { if (!fusing) setPendingFuse(null) }}
        title={t('databankPanel.fuseTitle')}
        message={pendingFuse ? t('databankPanel.fuseMessage', {
          count: pendingFuse.sourceCount,
          sourceName: pendingFuse.sourceName,
          targetName: databanks.find((b) => b.id === selectedDatabankId)?.name ?? t('databankPanel.thisDatabank'),
        }) : ''}
        variant="danger"
        confirmText={t('databankPanel.fuse')}
        loading={fusing}
        loadingText={t('databankPanel.fusing')}
      />
    </div>
  )
}
