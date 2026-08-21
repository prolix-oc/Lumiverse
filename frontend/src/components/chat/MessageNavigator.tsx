import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { messagesApi } from '@/api/chats'
import { ModalShell } from '@/components/shared/ModalShell'
import type { Message } from '@/types/api'
import type { ChatFindNavigationTarget } from './ChatFindBar'
import styles from './MessageNavigator.module.css'

interface MessageNavigatorProps {
  chatId: string
  open: boolean
  onClose: () => void
  onNavigate: (target: ChatFindNavigationTarget) => void
}

const PAGE_SIZE = 40

function previewMessage(message: Message) {
  return message.content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || '—'
}

export default function MessageNavigator({ chatId, open, onClose, onNavigate }: MessageNavigatorProps) {
  const { t } = useTranslation('chat', { keyPrefix: 'messageNavigator' })
  const requestRef = useRef(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const loadPage = useCallback(async (nextOffset?: number, tail = false) => {
    const request = ++requestRef.current
    setLoading(true)
    setFailed(false)
    try {
      const page = await messagesApi.list(chatId, tail
        ? { limit: PAGE_SIZE, tail: true }
        : { limit: PAGE_SIZE, offset: Math.max(0, nextOffset ?? 0) })
      if (request !== requestRef.current) return
      setMessages(page.data)
      setOffset(page.offset)
      setTotal(page.total)
    } catch {
      if (request !== requestRef.current) return
      setFailed(true)
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    if (!open) return
    void loadPage(undefined, true)
  }, [loadPage, open])

  const lastOffset = Math.max(0, total - PAGE_SIZE)
  const pageStart = total === 0 ? 0 : offset + 1
  const pageEnd = Math.min(total, offset + messages.length)

  return (
    <ModalShell
      isOpen={open}
      onClose={onClose}
      maxWidth={680}
      maxHeight="min(720px, 85vh)"
    >
      <section className={styles.panel} role="dialog" aria-modal="true" aria-label={t('title')}>
        <header className={styles.header}>
          <div>
            <h2>{t('title')}</h2>
            <p>{t('range', { start: pageStart, end: pageEnd, total })}</p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label={t('close')}>
            <X size={17} />
          </button>
        </header>

        <div className={styles.list} aria-busy={loading}>
          {loading && messages.length === 0 && <div className={styles.status}>{t('loading')}</div>}
          {failed && <div className={styles.status}>{t('failed')}</div>}
          {!loading && !failed && messages.length === 0 && <div className={styles.status}>{t('empty')}</div>}
          {messages.map((message, index) => {
            const ordinal = offset + index + 1
            const date = new Date(message.send_date * 1000)
            return (
              <button
                type="button"
                className={styles.messageRow}
                key={message.id}
                onClick={() => {
                  onNavigate({
                    id: message.id,
                    index_in_chat: message.index_in_chat,
                    offset: offset + index,
                    messageTotal: total,
                    requestId: Date.now(),
                  })
                  onClose()
                }}
              >
                <span className={styles.rowMeta}>
                  <strong>#{ordinal}</strong>
                  <span>{message.name || (message.is_user ? t('user') : t('assistant'))}</span>
                  <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
                </span>
                <span className={styles.preview}>{previewMessage(message)}</span>
              </button>
            )
          })}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.iconButton} disabled={loading || offset === 0} onClick={() => void loadPage(0)} aria-label={t('firstPage')}>
            <ChevronFirst size={17} />
          </button>
          <button type="button" className={styles.iconButton} disabled={loading || offset === 0} onClick={() => void loadPage(Math.max(0, offset - PAGE_SIZE))} aria-label={t('previousPage')}>
            <ChevronLeft size={17} />
          </button>
          <span>{t('range', { start: pageStart, end: pageEnd, total })}</span>
          <button type="button" className={styles.iconButton} disabled={loading || pageEnd >= total} onClick={() => void loadPage(offset + PAGE_SIZE)} aria-label={t('nextPage')}>
            <ChevronRight size={17} />
          </button>
          <button type="button" className={styles.iconButton} disabled={loading || pageEnd >= total} onClick={() => void loadPage(lastOffset)} aria-label={t('lastPage')}>
            <ChevronLast size={17} />
          </button>
        </footer>
      </section>
    </ModalShell>
  )
}
