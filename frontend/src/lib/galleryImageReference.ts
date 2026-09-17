import type { CharacterGalleryItem } from '@/types/api'
import { replaceHtmlImageSources } from './htmlImageSources'

export const GALLERY_IMAGE_REFERENCE_PREFIX = 'gallery://'

export function createGalleryImageReference(token: string): string {
  return `${GALLERY_IMAGE_REFERENCE_PREFIX}${token}`
}

export function resolveGalleryImageId(
  source: string,
  assetMap: Record<string, string>,
): string | undefined {
  return source.startsWith(GALLERY_IMAGE_REFERENCE_PREFIX) ? assetMap[source] : undefined
}

/**
 * Resolve gallery sources without replacing the surrounding HTML image tag.
 * Regex-authored classes, styles, dimensions, and data attributes therefore
 * survive while the browser receives an ordinary same-origin image URL.
 */
export function resolveGalleryImageSourcesInHtml(
  text: string,
  assetMap: Record<string, string>,
): string {
  return replaceHtmlImageSources(
    text, 'gallery',
    (match, before: string, quote: string, source: string, after: string) => {
      const imageId = resolveGalleryImageId(source.trim(), assetMap)
      if (!imageId) return match
      const localSource = `/api/v1/images/${encodeURIComponent(imageId)}`
      return `<img${before}src=${quote}${localSource}${quote}${after}>`
    },
  )
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ').trim()
}

export function galleryImageMarkdown(item: CharacterGalleryItem, fallbackAlt = 'Gallery image'): string {
  const alt = escapeMarkdownAlt(item.caption) || fallbackAlt
  const reference = item.reference || createGalleryImageReference(item.id)
  return `![${alt}](${reference})`
}
