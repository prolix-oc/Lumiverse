export interface ExtensionUpdateInfo {
  extensionId: string
  identifier: string
  name: string
  currentVersion: string
  branch: string
  localCommit: string
  remoteCommit: string
}

export interface ExtensionUpdateSnapshot {
  updates: ExtensionUpdateInfo[]
  checkedAt: number | null
  checking: boolean
}
