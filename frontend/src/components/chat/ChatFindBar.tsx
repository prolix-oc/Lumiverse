import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { messagesApi } from '@/api/chats'
import type { ChatMessageSearchMatch } from '@/types/api'
import styles from './ChatFindBar.module.css'

export interface ChatFindNavigationTarget extends ChatMessageSearchMatch {
  messageTotal: number
  requestId: number
}

interface ChatFindBarProps {
  chatId: string
  open: boolean
  focusRequest: number
  onClose: () => void
  onNavigate: (target: ChatFindNavigationTarget) => void
  onClearTarget: () => void
  onQueryChange: (query: string) => void
}

export default function ChatFindBar({ chatId, open, focusRequest, onClose, onNavigate, onClearTarget, onQueryChange }: ChatFindBarProps) {
  const { t } = useTranslation('chat', { keyPrefix: 'findInChat' })
  const inputRef = useRef<HTMLInputElement>(null)
  const navigationRequestRef = useRef(0)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<ChatMessageSearchMatch[]>([])
  const [matchTotal, setMatchTotal] = useState(0)
  const [messageTotal, setMessageTotal] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const clearResults = useCallback(() => {
    setMatches([])
    setMatchTotal(0)
    setMessageTotal(0)
    setCurrentIndex(0)
    setLoading(false)
    setFailed(false)
    onClearTarget()
  }, [onClearTarget])

  const close = useCallback(() => {
    setQuery('')
    onQueryChange('')
    clearResults()
    onClose()
  }, [clearResults, onClose, onQueryChange])

  const navigateTo = useCallback((nextIndex: number, sourceMatches = matches, sourceMessageTotal = messageTotal) => {
    if (sourceMatches.length === 0) return
    const normalized = (nextIndex + sourceMatches.length) % sourceMatches.length
    setCurrentIndex(normalized)
    onNavigate({
      ...sourceMatches[normalized],
      messageTotal: sourceMessageTotal,
      requestId: ++navigationRequestRef.current,
    })
  }, [matches, messageTotal, onNavigate])

  useEffect(() => {
    if (!open) {
      setQuery('')
      onQueryChange('')
      clearResults()
      return
    }

    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [clearResults, focusRequest, onQueryChange, open])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (!open || !normalizedQuery) {
      clearResults()
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setFailed(false)
      messagesApi.search(chatId, normalizedQuery, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          setMatches(result.data)
          setMatchTotal(result.total)
          setMessageTotal(result.message_total)
          setCurrentIndex(0)
          setLoading(false)
          if (result.data.length > 0) {
            onNavigate({
              ...result.data[0],
              messageTotal: result.message_total,
              requestId: ++navigationRequestRef.current,
            })
          } else {
            onClearTarget()
          }
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setMatches([])
          setMatchTotal(0)
          setMessageTotal(0)
          setCurrentIndex(0)
          setLoading(false)
          setFailed(true)
          onClearTarget()
        })
    }, 150)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [chatId, clearResults, onClearTarget, onNavigate, open, query])

  if (!open) return null

  const displayTotal = matchTotal > matches.length ? `${matches.length}+` : String(matchTotal)
  const matchCount = loading
    ? t('loading')
    : failed
      ? t('searchFailed')
      : matches.length === 0
        ? t('noMatches')
        : t('matchCount', { current: currentIndex + 1, total: displayTotal })

  return (
    <div className={styles.bar} data-component="ChatFindBar" role="search">
      <Search size={14} className={styles.searchIcon} aria-hidden="true" />
      <input
        ref={inputRef}
        className={styles.input}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          onQueryChange(event.target.value.trim())
          clearResults()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            navigateTo(currentIndex + (event.shiftKey ? -1 : 1))
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        placeholder={t('placeholder')}
        aria-label={t('open')}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      {query && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setQuery('')
            onQueryChange('')
            clearResults()
            inputRef.current?.focus()
          }}
          title={t('clear')}
          aria-label={t('clear')}
        >
          <X size={13} />
        </button>
      )}
      <span className={styles.matchCount} aria-live="polite">{matchCount}</span>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => navigateTo(currentIndex - 1)}
        disabled={matches.length === 0}
        title={t('previous')}
        aria-label={t('previous')}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => navigateTo(currentIndex + 1)}
        disabled={matches.length === 0}
        title={t('next')}
        aria-label={t('next')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={close}
        title={t('close')}
        aria-label={t('close')}
      >
        <X size={14} />
      </button>
    </div>
  )
}
