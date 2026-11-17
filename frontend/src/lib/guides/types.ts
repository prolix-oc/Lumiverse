import type { SpindleGuideDefinition } from 'lumiverse-spindle-types'

export interface BuiltinGuideDefinition {
  kind: 'builtin'
  path: string
  title?: string
}

export interface GuideCatalogEntry {
  path: string
  title: string
  searchText?: string
}

export interface SpindleGuidePage {
  /** Relative Markdown path within this guide, for example "setup/windows.md". */
  path: string
  title?: string
  markdown: string
}

// Keep this additive host contract compatible with the published Spindle SDK.
declare module 'lumiverse-spindle-types' {
  interface SpindleGuideDefinition {
    /** Additional local pages. The existing markdown field is rendered as index.md. */
    pages?: readonly SpindleGuidePage[]
  }
}

export interface MarkdownGuideDefinition extends SpindleGuideDefinition {
  kind: 'markdown'
}

export type GuideDefinition =
  | BuiltinGuideDefinition
  | MarkdownGuideDefinition