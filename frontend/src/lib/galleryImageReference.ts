import type { CharacterGalleryItem } from '@/types/api'

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

function escapeMarkdownAlt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ').trim()
}

export function galleryImageMarkdown(item: CharacterGalleryItem, fallbackAlt = 'Gallery image'): string {
  const alt = escapeMarkdownAlt(item.caption) || fallbackAlt
  const reference = item.reference || createGalleryImageReference(item.id)
  return `![${alt}](${reference})`
}
