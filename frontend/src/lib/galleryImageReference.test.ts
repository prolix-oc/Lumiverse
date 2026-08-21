import { describe, expect, test } from 'bun:test'
import { galleryImageMarkdown, resolveGalleryImageId } from './galleryImageReference'
import type { CharacterGalleryItem } from '@/types/api'

function item(overrides: Partial<CharacterGalleryItem> = {}): CharacterGalleryItem {
  return {
    id: 'item-id',
    image_id: 'image-id',
    caption: '',
    reference: 'gallery://image-1',
    sort_order: 0,
    created_at: 0,
    width: null,
    height: null,
    mime_type: 'image/png',
    ...overrides,
  }
}

describe('galleryImageMarkdown', () => {
  test('builds a portable Markdown image stub', () => {
    expect(galleryImageMarkdown(item({ caption: 'Opening scene' }))).toBe(
      '![Opening scene](gallery://image-1)',
    )
  })

  test('escapes Markdown alt text and falls back when there is no caption', () => {
    expect(galleryImageMarkdown(item({ caption: 'A [scene]\ncontinued' }))).toBe(
      '![A \\[scene\\] continued](gallery://image-1)',
    )
    expect(galleryImageMarkdown(item(), 'Character image')).toBe(
      '![Character image](gallery://image-1)',
    )
  })

  test('resolves a character-scoped slot to the installation-local image ID', () => {
    expect(resolveGalleryImageId('gallery://image-1', {
      'gallery://image-1': 'local-image-id',
    })).toBe('local-image-id')
  })
})
