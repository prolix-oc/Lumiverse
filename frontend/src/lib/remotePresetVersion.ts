/** Illarin release numbers identify versions even when publisher labels repeat. */
export function remotePresetVersionLabel(
  source: unknown,
  label: unknown,
  versionNumber: unknown,
): string {
  const text = typeof label === 'string' ? label.trim() : ''
  if (source !== 'illarin' || typeof versionNumber !== 'number'
    || !Number.isSafeInteger(versionNumber) || versionNumber < 1) return text
  const release = String(versionNumber)
  return text && text.replace(/^v/i, '') !== release ? `${release} (${text})` : release
}
