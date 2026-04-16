import { useState, useCallback, useEffect, useRef } from 'react'
import { Database, Plus, Trash2, Upload, Search, FileText, RefreshCw, Globe, User, MessageSquare, X, ChevronDown, Check } from 'lucide-react'
import { useStore } from '@/store'
import { databankApi } from '@/api/databank'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import type { Databank, DatabankDocument } from '@/api/databank'
import styles from './DatabankPanel.module.css'

type Scope = 'global' | 'character' | 'chat'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function StatusBadge({ status }: { status: DatabankDocument['status'] }) {
  const cls = {
    pending: styles.statusPending,
    processing: styles.statusProcessing,
    ready: styles.statusReady,
    error: styles.statusError,
  }[status]
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>
}

export default function DatabankPanel() {
  const {
    databanks, databankDocuments, selectedDatabankId, databankScopeFilter,
    setDatabanks, addDatabank, removeDatabank, updateDatabank: updateBankStore,
    setSelectedDatabankId, setDatabankScopeFilter,
    setDatabankDocuments, addDatabankDocument, removeDatabankDocument, updateDatabankDocument,
  } = useStore()

  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)

  const [docSearch, setDocSearch] = useState('')
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Cross-reference: all user databanks (for selectors) ──
  const [allBanks, setAllBanks] = useState<Databank[]>([])
  const [charDatabankIds, setCharDatabankIds] = useState<string[]>([])
  const [charExtensions, setCharExtensions] = useState<Record<string, any>>({})
  const [chatDatabankIds, setChatDatabankIds] = useState<string[]>([])
  const [chatMetadata, setChatMetadata] = useState<Record<string, any>>({})
  const [charPickerOpen, setCharPickerOpen] = useState(false)
  const [chatPickerOpen, setChatPickerOpen] = useState(false)

  // Load all banks for cross-reference selectors
  useEffect(() => {
    databankApi.list({ limit: 200 }).then((r) => setAllBanks(r.data)).catch(() => {})
  }, [databanks]) // refresh when databanks change (create/delete)

  // Load character databank bindings
  useEffect(() => {
    if (!activeCharacterId) { setCharDatabankIds([]); setCharExtensions({}); return }
    charactersApi.get(activeCharacterId).then((c: any) => {
      const ext = c.extensions || {}
      setCharExtensions(ext)
      const ids = Array.isArray(ext.databank_ids) ? ext.databank_ids.filter((id: unknown) => typeof id === 'string') : []
      setCharDatabankIds(ids)
    }).catch(() => {})
  }, [activeCharacterId])

  // Load chat databank bindings
  useEffect(() => {
    if (!activeChatId) { setChatDatabankIds([]); setChatMetadata({}); return }
    chatsApi.get(activeChatId).then((chat: any) => {
      const meta = chat.metadata || {}
      setChatMetadata(meta)
      setChatDatabankIds((meta.chat_databank_ids as string[]) ?? [])
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
    chatsApi.update(activeChatId, { metadata: meta }).catch(() => {})
  }, [activeChatId, chatDatabankIds, chatMetadata])

  // ── Load banks on mount and scope change ──
  const loadBanks = useCallback(async () => {
    try {
      const params: Record<string, string> = { scope: databankScopeFilter }
      if (databankScopeFilter === 'character' && activeCharacterId) {
        params.scope_id = activeCharacterId
      }
      if (databankScopeFilter === 'chat' && activeChatId) {
        params.scope_id = activeChatId
      }
      const result = await databankApi.list(params)
      setDatabanks(result.data)
    } catch {
      setDatabanks([])
    }
  }, [databankScopeFilter, activeCharacterId, activeChatId, setDatabanks])

  useEffect(() => { loadBanks() }, [loadBanks])

  // ── Load documents when bank selection changes ──
  const loadDocs = useCallback(async () => {
    if (!selectedDatabankId) {
      setDatabankDocuments([])
      return
    }
    try {
      const result = await databankApi.listDocuments(selectedDatabankId)
      setDatabankDocuments(result.data)
    } catch {
      setDatabankDocuments([])
    }
  }, [selectedDatabankId, setDatabankDocuments])

  useEffect(() => { loadDocs() }, [loadDocs])

  // ── Poll for document status updates ──
  useEffect(() => {
    const hasProcessing = databankDocuments.some((d) => d.status === 'pending' || d.status === 'processing')
    if (hasProcessing && selectedDatabankId) {
      pollRef.current = setInterval(async () => {
        try {
          const result = await databankApi.listDocuments(selectedDatabankId)
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
        name: 'New Databank',
        scope: databankScopeFilter,
        scope_id: scopeId || undefined,
      })
      addDatabank(bank)
      setSelectedDatabankId(bank.id)
    } catch (e: any) {
      setError(e.message)
    }
  }, [databankScopeFilter, activeCharacterId, activeChatId, addDatabank, setSelectedDatabankId])

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

  // ── Update bank name/description ──
  const handleBankUpdate = useCallback(async (field: 'name' | 'description', value: string) => {
    if (!selectedDatabankId) return
    try {
      await databankApi.update(selectedDatabankId, { [field]: value })
      updateBankStore(selectedDatabankId, { [field]: value })
    } catch { /* ignore */ }
  }, [selectedDatabankId, updateBankStore])

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
      setError(e.body?.error || e.message || 'Failed to scrape URL')
    } finally {
      setScraping(false)
    }
  }, [selectedDatabankId, scrapeUrl, addDatabankDocument])

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

  const activeCharBanks = allBanks.filter((b) => charDatabankIds.includes(b.id))
  const activeChatBanks = allBanks.filter((b) => chatDatabankIds.includes(b.id))

  return (
    <div className={styles.panel}>
      {/* Cross-reference: Character attachments */}
      {activeCharacterId && (
        <div className={styles.attachSection}>
          <div className={styles.attachHeader}>
            <User size={12} className={styles.attachIcon} />
            <span className={styles.attachLabel}>
              {characters.find(c => c.id === activeCharacterId)?.name || 'Character'} Databanks
            </span>
            <button
              type="button"
              className={styles.attachAddBtn}
              onClick={() => setCharPickerOpen((p) => !p)}
            >
              <Plus size={11} />
              <span>Attach</span>
              <ChevronDown size={10} className={charPickerOpen ? styles.chevronOpen : ''} />
            </button>
          </div>
          {charPickerOpen && (
            <div className={styles.attachPicker}>
              {allBanks.length === 0 ? (
                <div className={styles.attachPickerEmpty}>No databanks available</div>
              ) : (
                allBanks.map((b) => {
                  const isActive = charDatabankIds.includes(b.id)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`${styles.attachPickerItem} ${isActive ? styles.attachPickerItemActive : ''}`}
                      onClick={() => toggleCharBank(b.id)}
                    >
                      <span className={styles.attachCheck}>{isActive ? <Check size={11} /> : null}</span>
                      <span className={styles.attachPickerName}>{b.name}</span>
                      <span className={styles.attachPickerScope}>{b.scope}</span>
                    </button>
                  )
                })
              )}
            </div>
          )}
          {activeCharBanks.length > 0 && (
            <div className={styles.attachPills}>
              {activeCharBanks.map((b) => (
                <span key={b.id} className={styles.attachPill}>
                  <span>{b.name}</span>
                  <button type="button" className={styles.attachPillRemove} onClick={() => toggleCharBank(b.id)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {activeCharBanks.length === 0 && !charPickerOpen && (
            <span className={styles.attachHint}>No databanks attached to this character</span>
          )}
        </div>
      )}

      {/* Cross-reference: Chat attachments */}
      {activeChatId && (
        <div className={styles.attachSection}>
          <div className={styles.attachHeader}>
            <MessageSquare size={12} className={styles.attachIcon} />
            <span className={styles.attachLabel}>This Chat</span>
            <button
              type="button"
              className={styles.attachAddBtn}
              onClick={() => setChatPickerOpen((p) => !p)}
            >
              <Plus size={11} />
              <span>Attach</span>
              <ChevronDown size={10} className={chatPickerOpen ? styles.chevronOpen : ''} />
            </button>
          </div>
          {chatPickerOpen && (
            <div className={styles.attachPicker}>
              {allBanks.length === 0 ? (
                <div className={styles.attachPickerEmpty}>No databanks available</div>
              ) : (
                allBanks.map((b) => {
                  const isActive = chatDatabankIds.includes(b.id)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`${styles.attachPickerItem} ${isActive ? styles.attachPickerItemActive : ''}`}
                      onClick={() => toggleChatBank(b.id)}
                    >
                      <span className={styles.attachCheck}>{isActive ? <Check size={11} /> : null}</span>
                      <span className={styles.attachPickerName}>{b.name}</span>
                      <span className={styles.attachPickerScope}>{b.scope}</span>
                    </button>
                  )
                })
              )}
            </div>
          )}
          {activeChatBanks.length > 0 && (
            <div className={styles.attachPills}>
              {activeChatBanks.map((b) => (
                <span key={b.id} className={styles.attachPill}>
                  <span>{b.name}</span>
                  <button type="button" className={styles.attachPillRemove} onClick={() => toggleChatBank(b.id)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {activeChatBanks.length === 0 && !chatPickerOpen && (
            <span className={styles.attachHint}>No databanks attached to this chat</span>
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
            {s === 'global' ? 'Global' : s === 'character' ? 'Character' : 'Chat'}
          </button>
        ))}
      </div>

      {/* Character picker for character scope */}
      {databankScopeFilter === 'character' && (
        <select
          className={`${styles.bankSelect} ${styles.scopeCharPicker}`}
          value={activeCharacterId || ''}
          disabled
          title="Automatically scoped to the active character"
        >
          <option value="">{activeCharacterId ? characters.find(c => c.id === activeCharacterId)?.name || 'Active Character' : 'No character active'}</option>
        </select>
      )}

      {/* Chat scope hint */}
      {databankScopeFilter === 'chat' && !activeChatId && (
        <div className={styles.emptyHint}>Open a chat to manage chat-scoped banks</div>
      )}

      {/* Bank selector bar */}
      <div className={styles.topBar}>
        <select
          className={styles.bankSelect}
          value={selectedDatabankId || ''}
          onChange={(e) => setSelectedDatabankId(e.target.value || null)}
        >
          <option value="">Select a databank...</option>
          {databanks.map((b) => (
            <option key={b.id} value={b.id}>{b.name} ({b.documentCount ?? 0})</option>
          ))}
        </select>
        <button className={styles.actionBtn} onClick={handleCreate} title="Create databank">
          <Plus size={14} />
        </button>
        {selectedDatabankId && (
          <button className={`${styles.actionBtn} ${styles.deleteBtn}`} onClick={handleDeleteBank} title="Delete databank">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {error && <div style={{ color: 'var(--lumiverse-danger)', fontSize: 11, padding: '0 4px' }}>{error}</div>}

      {/* Bank details */}
      {selectedBank && (
        <div className={styles.bankDetails}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Name</label>
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
            <label className={styles.fieldLabel}>Description</label>
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
            <span className={styles.scopeBadge}>{selectedBank.scope}</span>
          </div>
        </div>
      )}

      {/* Upload Zone */}
      {selectedDatabankId && (
        <>
          <div
            className={`${styles.uploadZone} ${dragging ? styles.uploadZoneDragging : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={24} className={styles.uploadIcon} />
            <span>{loading ? 'Uploading...' : 'Drop files here or click to browse'}</span>
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
            placeholder="Paste a URL to scrape..."
            value={scrapeUrl}
            onChange={(e) => setScrapeUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleScrape() }}
            disabled={scraping}
          />
          <button
            className={styles.actionBtn}
            onClick={handleScrape}
            disabled={scraping || !scrapeUrl.trim()}
            title="Scrape web page"
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
            placeholder="Search documents..."
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
          />
        </div>
      )}

      {/* Document List */}
      {selectedDatabankId && (
        <div className={styles.docList}>
          {filteredDocs.map((doc) => (
            <div key={doc.id} className={styles.docRow}>
              <FileText size={16} className={styles.docIcon} />
              <div className={styles.docInfo}>
                <input
                  className={styles.docNameInput}
                  defaultValue={doc.name}
                  onBlur={(e) => {
                    const val = e.target.value.trim()
                    if (val && val !== doc.name) handleRenameDoc(doc.id, val)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  title="Click to rename"
                />
                <div className={styles.docMeta}>
                  {formatFileSize(doc.fileSize)}
                  {doc.totalChunks > 0 && ` \u00B7 ${doc.totalChunks} chunks`}
                  {doc.slug && <span> &middot; #{doc.slug}</span>}
                </div>
              </div>
              <div className={styles.docActions}>
                <StatusBadge status={doc.status} />
                <button
                  className={styles.smallDeleteBtn}
                  onClick={(e) => { e.stopPropagation(); handleDeleteDoc(doc.id) }}
                  title="Delete document"
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
          <div className={styles.emptyText}>No databanks yet</div>
          <div className={styles.emptyHint}>
            Create a databank to upload reference documents that the AI can access during conversations.
          </div>
        </div>
      )}

      {selectedDatabankId && databankDocuments.length === 0 && !loading && (
        <div className={styles.emptyState}>
          <FileText size={24} className={styles.emptyIcon} />
          <div className={styles.emptyText}>No documents</div>
          <div className={styles.emptyHint}>Upload text files to populate this databank.</div>
        </div>
      )}
    </div>
  )
}
