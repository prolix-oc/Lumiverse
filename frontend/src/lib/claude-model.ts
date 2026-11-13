// Keep this browser-side capability check aligned with src/utils/claude-model.ts.
// Model IDs may use a hyphen or dot for the version. Limit the optional minor
// to two digits so dated aliases are not interpreted as point releases.
const CLAUDE_OPUS_VERSION = /(?:^|[\/:])claude-opus-(\d+)(?:[-.](\d{1,2}))?(?=$|[-.:@])/i

/** Opus 4.7 remains eligible; Opus 4.8+ is enabled by numeric version. */
export function supportsClaudeOpusXhigh(model: string | null | undefined): boolean {
  const match = model?.trim().match(CLAUDE_OPUS_VERSION)
  if (!match) return false

  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  return (major === 4 && minor === 7) || major > 4 || (major === 4 && minor >= 8)
}
