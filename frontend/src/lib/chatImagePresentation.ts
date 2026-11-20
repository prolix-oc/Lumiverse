import type { CSSProperties } from 'react'

export type ChatImageSize = 'default' | '100' | '75' | '50'
export type ChatImageAlignment = 'left' | 'center' | 'right'
export interface ChatImageTargets {
  markdown: boolean
  html: boolean
  attachments: boolean
}

export const DEFAULT_CHAT_IMAGE_TARGETS: Readonly<ChatImageTargets> = Object.freeze({
  markdown: true,
  html: true,
  attachments: true,
})

export function isChatImageTargets(value: unknown): value is ChatImageTargets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const targets = value as Record<string, unknown>
  return ['markdown', 'html', 'attachments'].every(key => typeof targets[key] === 'boolean')
}

export function isChatImageSize(value: unknown): value is ChatImageSize {
  return value === 'default' || value === '100' || value === '75' || value === '50'
}

export function isChatImageAlignment(value: unknown): value is ChatImageAlignment {
  return value === 'left' || value === 'center' || value === 'right'
}

/** Shared sizing and alignment for prose, isolated HTML and attachments. */
export function chatImagePresentationStyle(size: ChatImageSize = 'default', alignment: ChatImageAlignment = 'left'): CSSProperties {
  return {
    ...(size !== 'default' && {
      '--chat-image-width': size + '%',
      '--chat-image-max-height': 'none',
    }),
    ...((size !== 'default' || alignment !== 'left') && {
      '--chat-image-object-position': alignment,
      '--chat-image-margin-left': alignment === 'left' ? '0' : 'auto',
      '--chat-image-margin-right': alignment === 'right' ? '0' : 'auto',
    }),
  } as CSSProperties
}
