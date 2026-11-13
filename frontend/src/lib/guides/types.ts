import type { SpindleGuideDefinition } from 'lumiverse-spindle-types'

export interface BuiltinGuideDefinition {
  kind: 'builtin'
  path: string
  title?: string
}

export type MarkdownGuideDefinition =
  SpindleGuideDefinition & {
    kind: 'markdown'
  }

export type GuideDefinition =
  | BuiltinGuideDefinition
  | MarkdownGuideDefinition