import type { SpindleGuideDefinition } from 'lumiverse-spindle-types'
import type { MarkdownGuideDefinition } from './types'

export function adaptSpindleGuide(
  guide: SpindleGuideDefinition | undefined,
): MarkdownGuideDefinition | undefined {
  if (!guide) {
    return undefined
  }

  return {
    ...guide,
    kind: 'markdown',
  }
}