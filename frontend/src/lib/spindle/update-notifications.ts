import type { ExtensionUpdateInfo } from '@/types/spindle-updates'

export function extensionUpdateFingerprint(update: ExtensionUpdateInfo): string {
  return `${update.extensionId}:${update.remoteCommit}`
}

export function selectToastableExtensionUpdates(
  updates: readonly ExtensionUpdateInfo[],
  disabledByIdentifier: Readonly<Record<string, boolean>> | null | undefined,
  announced: ReadonlySet<string>,
): ExtensionUpdateInfo[] {
  return updates.filter((update) =>
    disabledByIdentifier?.[update.identifier] !== true
    && !announced.has(extensionUpdateFingerprint(update))
  )
}

export function pruneAnnouncedExtensionUpdates(
  announced: ReadonlySet<string>,
  updates: readonly ExtensionUpdateInfo[],
): Set<string> {
  const active = new Set(updates.map(extensionUpdateFingerprint))
  return new Set([...announced].filter((fingerprint) => active.has(fingerprint)))
}
