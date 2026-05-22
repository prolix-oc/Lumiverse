import { useCallback, useEffect, useRef, useState } from 'react'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { GroupedRecentChat } from '@/types/api'
import type { CharacterSortField, CharacterSortDirection } from '@/types/store'

const SEARCH_DEBOUNCE_MS = 150
const GROUP_CHATS_FETCH_LIMIT = 500

function resolveSort(sortField: CharacterSortField): 'name' | 'recent' | 'created' {
  return sortField === 'shuffle' ? 'recent' : sortField
}

function resolveDirection(
  sortField: CharacterSortField,
  sortDirection: CharacterSortDirection,
): 'asc' | 'desc' {
  // shuffle has no direction; coerce so newest groups stay at the top.
  return sortField === 'shuffle' ? 'desc' : sortDirection
}

export function useGroupChatBrowser() {
  const searchQuery = useStore((s) => s.searchQuery)
  const sortField = useStore((s) => s.sortField)
  const sortDirection = useStore((s) => s.sortDirection)

  const [groupChats, setGroupChats] = useState<GroupedRecentChat[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [fetchVersion, setFetchVersion] = useState(0)
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params: Parameters<typeof chatsApi.listRecentGrouped>[0] = {
      limit: GROUP_CHATS_FETCH_LIMIT,
      offset: 0,
      sort: resolveSort(sortField),
      direction: resolveDirection(sortField, sortDirection),
    }
    const trimmed = debouncedQuery.trim()
    if (trimmed) params.search = trimmed

    chatsApi
      .listRecentGrouped(params)
      .then((result) => {
        if (cancelled) return
        const groupsOnly = result.data.filter((c) => c.is_group === true)
        setGroupChats(groupsOnly)
        setTotal(groupsOnly.length)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[useGroupChatBrowser] Failed to load:', err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [debouncedQuery, sortField, sortDirection, fetchVersion])

  useEffect(() => {
    const refresh = () => setFetchVersion((v) => v + 1)
    const offCreated = wsClient.on(EventType.CHAT_CREATED, refresh)
    const offDeleted = wsClient.on(EventType.CHAT_DELETED, refresh)
    const offUpdated = wsClient.on(EventType.CHAT_UPDATED, refresh)
    return () => {
      offCreated()
      offDeleted()
      offUpdated()
    }
  }, [])

  const removeLocal = useCallback((latestChatId: string) => {
    setGroupChats((prev) => prev.filter((c) => c.latest_chat_id !== latestChatId))
    setTotal((t) => Math.max(0, t - 1))
  }, [])

  const refresh = useCallback(() => setFetchVersion((v) => v + 1), [])

  return {
    groupChats,
    total,
    loading,
    refresh,
    removeLocal,
  }
}
