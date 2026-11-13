import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { messagesApi } from '@/api/chats'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'

export function useMessageSelect(chatId: string) {
  const { t } = useTranslation('chat', { keyPrefix: 'toast' })
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const selectedMessageIds = useStore((s) => s.selectedMessageIds)
  const messages = useStore((s) => s.messages)
  const setMessageSelectMode = useStore((s) => s.setMessageSelectMode)
  const toggleMessageSelect = useStore((s) => s.toggleMessageSelect)
  const selectAllMessages = useStore((s) => s.selectAllMessages)
  const clearMessageSelection = useStore((s) => s.clearMessageSelection)
  const selectMessageRange = useStore((s) => s.selectMessageRange)
  const removeMessage = useStore((s) => s.removeMessage)

  const selectedCount = selectedMessageIds.length
  const totalCount = messages.length

  const hasHiddenSelected = useMemo(
    () => selectedMessageIds.some((id) => {
      const msg = messages.find((m) => m.id === id)
      return msg?.extra?.hidden === true
    }),
    [selectedMessageIds, messages]
  )

  const hasVisibleSelected = useMemo(
    () => selectedMessageIds.some((id) => {
      const msg = messages.find((m) => m.id === id)
      return !msg?.extra?.hidden
    }),
    [selectedMessageIds, messages]
  )

  const enterSelectMode = useCallback(() => {
    setMessageSelectMode(true)
  }, [setMessageSelectMode])

  const exitSelectMode = useCallback(() => {
    setMessageSelectMode(false)
  }, [setMessageSelectMode])

  const bulkCopy = useCallback(async () => {
    const selectedIds = new Set(selectedMessageIds)
    const selectedMessages = messages.filter((message) => selectedIds.has(message.id))
    if (selectedMessages.length === 0) return
    try {
      await copyTextToClipboard(selectedMessages.map((message) => message.content).join('\n\n---\n\n'))
      toast.success(t('messagesCopied', { count: selectedMessages.length }))
      setMessageSelectMode(false)
    } catch (err) {
      console.error('[useMessageSelect] Bulk copy failed:', err)
      toast.error(t('failedCopyMessages'))
    }
  }, [messages, selectedMessageIds, setMessageSelectMode, t])

  const bulkHide = useCallback(async (hidden: boolean) => {
    if (selectedMessageIds.length === 0) return
    try {
      const result = await messagesApi.bulkHide(chatId, selectedMessageIds, hidden)
      toast.success(hidden
        ? t('messagesHidden', { count: result.updated })
        : t('messagesUnhidden', { count: result.updated }))
      setMessageSelectMode(false)
    } catch (err) {
      console.error('[useMessageSelect] Bulk hide failed:', err)
      toast.error(t('failedUpdateMessages'))
    }
  }, [chatId, selectedMessageIds, setMessageSelectMode, t])

  const bulkDelete = useCallback(async () => {
    if (selectedMessageIds.length === 0) return
    try {
      const result = await messagesApi.bulkDelete(chatId, selectedMessageIds)
      for (const id of selectedMessageIds) {
        removeMessage(id)
      }
      toast.success(t('messagesDeleted', { count: result.deleted }))
      setMessageSelectMode(false)
    } catch (err) {
      console.error('[useMessageSelect] Bulk delete failed:', err)
      toast.error(t('failedDeleteMessages'))
    }
  }, [chatId, selectedMessageIds, removeMessage, setMessageSelectMode, t])

  return {
    messageSelectMode,
    selectedMessageIds,
    selectedCount,
    totalCount,
    hasHiddenSelected,
    hasVisibleSelected,
    enterSelectMode,
    exitSelectMode,
    toggleMessageSelect,
    selectAllMessages,
    clearMessageSelection,
    selectMessageRange,
    bulkCopy,
    bulkHide,
    bulkDelete,
  }
}
