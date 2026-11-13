export interface SearchableConnection {
  id: string
  name?: string
  provider: string
  model?: string
}

export function filterConnections<T extends SearchableConnection>(
  profiles: readonly T[], query: string, folderFor: (id: string) => string = () => '',
): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return profiles.filter((profile) => {
    const text = [profile.name, profile.provider, profile.model, folderFor(profile.id)]
      .filter(Boolean).join(' ').toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
}
