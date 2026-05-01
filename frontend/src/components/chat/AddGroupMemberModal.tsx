import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Search, UserPlus } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import type { CharacterSummary } from '@/types/api'
import { getCharacterAvatarThumbUrlById } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/shared/Spinner'
import Pagination from '@/components/shared/Pagination'
import styles from './AddGroupMemberModal.module.css'

const CHARS_PER_PAGE = 50

export default function AddGroupMemberModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const setGroupCharacterIds = useStore((s) => s.setGroupCharacterIds)

  const chatId = modalProps.chatId as string
  const seededCharacterIds = useMemo(
    () => Array.isArray(modalProps.existingCharacterIds)
      ? modalProps.existingCharacterIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [],
    [modalProps.existingCharacterIds]
  )
  const memberIds = useMemo(
    () => (seededCharacterIds.length > 0
      ? Array.from(new Set([...seededCharacterIds, ...groupCharacterIds]))
      : groupCharacterIds),
    [seededCharacterIds, groupCharacterIds]
  )
  const [search, setSearch] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [allSummaries, setAllSummaries] = useState<CharacterSummary[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch all character summaries on mount
  useEffect(() => {
    let cancelled = false
    async function fetchAll() {
      setLoading(true)
      try {
        const res = await charactersApi.listSummaries({ limit: 200, offset: 0 })
        if (cancelled) return
        let items = res.data ?? []
        // If there are more, paginate through all
        while (items.length < res.total) {
          const next = await charactersApi.listSummaries({ limit: 200, offset: items.length })
          if (cancelled) return
          items = items.concat(next.data ?? [])
        }
        setAllSummaries(items)
      } catch (err) {
        console.error('[AddGroupMember] Failed to load characters:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchAll()
    return () => { cancelled = true }
  }, [])

  // Filter out current group members, then apply search
  const available = useMemo(() => {
    const nonMembers = allSummaries.filter((c) => !memberIds.includes(c.id))
    if (!search.trim()) return nonMembers
    const q = search.toLowerCase()
    return nonMembers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }, [allSummaries, memberIds, search])

  useEffect(() => { setPage(1) }, [search])

  const totalPages = Math.max(1, Math.ceil(available.length / CHARS_PER_PAGE))
  const safePage = Math.min(page, totalPages)
  const pageChars = useMemo(() => {
    const start = (safePage - 1) * CHARS_PER_PAGE
    return available.slice(start, start + CHARS_PER_PAGE)
  }, [available, safePage])

  const handleAdd = useCallback(
    async (charId: string) => {
      if (addingId) return
      const char = allSummaries.find((c) => c.id === charId)
      setAddingId(charId)
      try {
        await chatsApi.addMember(chatId, charId)
        setGroupCharacterIds([...memberIds, charId])
        toast.success(`${char?.name || 'Character'} added to group`)
      } catch (err: any) {
        console.error('[AddGroupMember] Failed:', err)
        toast.error(err?.body?.error || 'Failed to add member')
      } finally {
        setAddingId(null)
      }
    },
    [chatId, allSummaries, memberIds, setGroupCharacterIds, addingId]
  )

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [closeModal])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) closeModal()
    },
    [closeModal]
  )

  const nonMemberCount = allSummaries.filter((c) => !memberIds.includes(c.id)).length

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <CloseButton onClick={closeModal} variant="solid" position="absolute" />

          <div className={styles.header}>
            <UserPlus size={18} className={styles.headerIcon} />
            <h3 className={styles.title}>Add Group Member</h3>
            <span className={styles.countBadge}>
              {loading ? '...' : `${nonMemberCount} available`}
            </span>
          </div>

          <div className={styles.body}>
            <div className={styles.searchBar}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="text"
                className={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search characters..."
                autoFocus
              />
            </div>

            {loading ? (
              <div className={styles.emptyState}>
                <Spinner size={20} fast />
              </div>
            ) : (
              <div className={styles.charGrid}>
                {pageChars.map((char) => {
                  const isAdding = addingId === char.id
                  const avatarUrl = char.image_id
                    ? getCharacterAvatarThumbUrlById(char.id, char.image_id)
                    : null
                  return (
                    <button
                      key={char.id}
                      type="button"
                      className={styles.charItem}
                      onClick={() => handleAdd(char.id)}
                      disabled={!!addingId}
                    >
                      <div className={styles.charAvatarWrap}>
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={char.name}
                            className={styles.charAvatar}
                            loading="lazy"
                          />
                        ) : (
                          <span className={styles.charAvatarFallback}>
                            {char.name[0]?.toUpperCase()}
                          </span>
                        )}
                        {isAdding && (
                          <span className={styles.addingOverlay}>
                            <Spinner size={18} fast />
                          </span>
                        )}
                      </div>
                      <span className={styles.charName}>{char.name}</span>
                    </button>
                  )
                })}
                {available.length === 0 && (
                  <div className={styles.emptyState}>
                    {nonMemberCount === 0
                      ? 'All your characters are already in this group.'
                      : 'No characters found.'}
                  </div>
                )}
              </div>
            )}

            {totalPages > 1 && (
              <Pagination
                currentPage={safePage}
                totalPages={totalPages}
                onPageChange={setPage}
                totalItems={available.length}
              />
            )}
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.footerBtn} onClick={closeModal}>
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
