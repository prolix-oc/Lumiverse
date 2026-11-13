import { createContext, useContext } from 'react'
import { filterConnections, type SearchableConnection } from '@/lib/connectionSearch'

export const ConnectionSearchContext = createContext('')

export function useConnectionSearch<T extends SearchableConnection>(
  profiles: readonly T[], folderFor?: (id: string) => string,
) {
  const query = useContext(ConnectionSearchContext)
  return { query, visibleProfiles: filterConnections(profiles, query, folderFor) }
}
