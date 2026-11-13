export type ConnectionPlacement = 'list' | 'recent' | 'preview'
export type ConnectionEditorPlacement = Exclude<ConnectionPlacement, 'preview'>

/** The canonical row keeps the profile ID used by folder sorting. */
export function connectionRowId(profileId: string, placement: ConnectionPlacement) {
  return placement === 'list' ? profileId : `${placement}:${profileId}`
}
