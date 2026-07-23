import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff, MessageSquare, Search, UserRound } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { Spinner } from '@/components/shared/Spinner'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import type { HiddenRecentChat } from '@/types/api'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import styles from './HiddenFromHomeModal.module.css'
import clsx from 'clsx'

type Tab = 'characters' | 'chats'

export default function HiddenFromHomeModal() {
  const { t } = useTranslation('landing')
  const { t: tc } = useTranslation('common')
  const closeModal = useStore((s) => s.closeModal)
  const characters = useStore((s) => s.characters)
  const hiddenCharacterIds = useStore((s) => s.landingHiddenCharacterIds)
  const setSetting = useStore((s) => s.setSetting)
  const [tab, setTab] = useState<Tab>('characters')
  const [query, setQuery] = useState('')
  const [hiddenChats, setHiddenChats] = useState<HiddenRecentChat[]>([])
  const [loadingChats, setLoadingChats] = useState(true)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const loadHiddenChats = useCallback(async () => {
    try {
      setLoadingChats(true)
      setHiddenChats(await chatsApi.listHiddenFromRecent())
    } catch (error) {
      console.error('[HiddenFromHome] Failed to load hidden chats:', error)
      toast.error(t('hiddenFromHome.loadFailed'))
    } finally {
      setLoadingChats(false)
    }
  }, [t])

  useEffect(() => {
    loadHiddenChats()
  }, [loadHiddenChats])

  const hiddenCharacters = useMemo(() => hiddenCharacterIds.map((id) => {
    const character = characters.find((item) => item.id === id)
    return { id, name: character?.name || t('hiddenFromHome.missingCharacter') }
  }), [characters, hiddenCharacterIds, t])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleCharacters = useMemo(() => hiddenCharacters.filter((character) => (
    !normalizedQuery || character.name.toLocaleLowerCase().includes(normalizedQuery)
  )), [hiddenCharacters, normalizedQuery])
  const visibleChats = useMemo(() => hiddenChats.filter((chat) => {
    if (!normalizedQuery) return true
    return chat.name.toLocaleLowerCase().includes(normalizedQuery)
      || chat.character_name.toLocaleLowerCase().includes(normalizedQuery)
  }), [hiddenChats, normalizedQuery])

  const restoreCharacter = useCallback((id: string) => {
    setSetting('landingHiddenCharacterIds', hiddenCharacterIds.filter((item) => item !== id))
  }, [hiddenCharacterIds, setSetting])

  const restoreChat = useCallback(async (id: string) => {
    try {
      setRestoringId(id)
      await chatsApi.patchMetadata(id, { hidden_from_recent: false })
      setHiddenChats((chats) => chats.filter((chat) => chat.id !== id))
    } catch (error) {
      console.error('[HiddenFromHome] Failed to restore chat:', error)
      toast.error(t('hiddenFromHome.restoreFailed'))
    } finally {
      setRestoringId(null)
    }
  }, [t])

  const restoreAll = useCallback(async () => {
    if (tab === 'characters') {
      setSetting('landingHiddenCharacterIds', [])
      return
    }
    try {
      setRestoringId('all')
      await Promise.all(hiddenChats.map((chat) => chatsApi.patchMetadata(chat.id, { hidden_from_recent: false })))
      setHiddenChats([])
    } catch (error) {
      console.error('[HiddenFromHome] Failed to restore all chats:', error)
      toast.error(t('hiddenFromHome.restoreFailed'))
      loadHiddenChats()
    } finally {
      setRestoringId(null)
    }
  }, [hiddenChats, loadHiddenChats, setSetting, tab, t])

  const count = tab === 'characters' ? hiddenCharacters.length : hiddenChats.length

  return (
    <ModalShell isOpen onClose={closeModal} maxWidth={620} maxHeight="80vh" className={styles.modal}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <EyeOff size={18} />
          <h2>{t('hiddenFromHome.title')}</h2>
        </div>
        <p>{t('hiddenFromHome.description')}</p>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('hiddenFromHome.title')}>
        <button type="button" role="tab" aria-selected={tab === 'characters'} className={clsx(styles.tab, tab === 'characters' && styles.tabActive)} onClick={() => setTab('characters')}>
          <UserRound size={14} /> {t('hiddenFromHome.characters', { count: hiddenCharacters.length })}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'chats'} className={clsx(styles.tab, tab === 'chats' && styles.tabActive)} onClick={() => setTab('chats')}>
          <MessageSquare size={14} /> {t('hiddenFromHome.chats', { count: hiddenChats.length })}
        </button>
      </div>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('hiddenFromHome.search')} />
        </label>
        {count > 0 && <Button variant="ghost" size="sm" onClick={restoreAll} disabled={restoringId !== null}>{t('hiddenFromHome.restoreAll')}</Button>}
      </div>

      <div className={styles.list}>
        {tab === 'characters' && (visibleCharacters.length === 0 ? (
          <EmptyState text={t('hiddenFromHome.noCharacters')} />
        ) : visibleCharacters.map((character) => (
          <div className={styles.row} key={character.id}>
            <span className={styles.rowIcon}><UserRound size={16} /></span>
            <span className={styles.rowText}><strong>{character.name}</strong><small>{t('hiddenFromHome.characterHint')}</small></span>
            <Button variant="ghost" size="sm" onClick={() => restoreCharacter(character.id)}>{t('hiddenFromHome.restore')}</Button>
          </div>
        )))}

        {tab === 'chats' && (loadingChats ? (
          <div className={styles.loading}><Spinner size={20} /></div>
        ) : visibleChats.length === 0 ? (
          <EmptyState text={t('hiddenFromHome.noChats')} />
        ) : visibleChats.map((chat) => (
          <div className={styles.row} key={chat.id}>
            <span className={styles.rowIcon}><MessageSquare size={16} /></span>
            <span className={styles.rowText}>
              <strong>{chat.name || t('hiddenFromHome.unnamedChat')}</strong>
              <small>{chat.is_group ? t('groupChat') : chat.character_name} · {formatRelativeTime(chat.updated_at)}</small>
            </span>
            <Button variant="ghost" size="sm" onClick={() => restoreChat(chat.id)} disabled={restoringId !== null}>{restoringId === chat.id ? <Spinner size={14} /> : t('hiddenFromHome.restore')}</Button>
          </div>
        )))}
      </div>

      <footer className={styles.footer}><Button variant="ghost" onClick={closeModal}>{tc('actions.close')}</Button></footer>
    </ModalShell>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className={styles.empty}>{text}</div>
}
