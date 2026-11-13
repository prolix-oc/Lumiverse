import { describe, expect, test } from 'bun:test'
import {
  galleryImageMarkdown,
  resolveGalleryImageId,
  resolveGalleryImageSourcesInHtml,
} from './galleryImageReference'
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

describe('resolveGalleryImageSourcesInHtml', () => {
  test('loads the local image while preserving regex-authored styling', () => {
    expect(resolveGalleryImageSourcesInHtml(
      '<div class="frame"><img class="scene" src="gallery://image-1" style="width:42%;border-radius:8px" data-panel="hero"></div>',
      { 'gallery://image-1': 'local image/id' },
    )).toBe(
      '<div class="frame"><img class="scene" src="/api/v1/images/local%20image%2Fid" style="width:42%;border-radius:8px" data-panel="hero"></div>',
    )
  })

  test('leaves unknown gallery references and non-gallery sources unchanged', () => {
    const content = [
      "<img src='gallery://image-2' class='missing'>",
      '<img src="https://example.com/scene.png" class="remote">',
    ].join(' ')

    expect(resolveGalleryImageSourcesInHtml(content, {
      'gallery://image-1': 'local-image-id',
    })).toBe(content)
  })
})

describe('gallery source boundaries', () => {
  test.each([
    ["<IMG class='scene' SRC = 'gallery://first' style='width:42%' data-panel='hero'>", "<img class='scene' src='/api/v1/images/local%20image%2Fid' style='width:42%' data-panel='hero'>"],
    ['<img src="gallery://first" src="gallery://last">', '<img src="/api/v1/images/local%20image%2Fid" src="gallery://last">'],
    ['<img src="missing" src="gallery://first">', '<img src="missing" src="gallery://first">'],
    ['<img data-src="gallery://first">', '<img data-src="gallery://first">'],
    ['<img src="gallery://first\'>', '<img src="gallery://first\'>'],
    ['<img src="gallery://a>b">', '<img src="/api/v1/images/greater-id">'],
  ])('preserves gallery attributes and source selection for %s', (raw, expected) => {
    expect(resolveGalleryImageSourcesInHtml(raw, { 'gallery://first': 'local image/id', 'gallery://last': 'last-id', 'gallery://a>b': 'greater-id' })).toBe(expected)
  })

  test('keeps malformed source runs unchanged', () => {
    const raw = '<img '.repeat(512) + 'src="a" '.repeat(512)
    expect(resolveGalleryImageSourcesInHtml(raw, { 'gallery://a': 'image-id' })).toBe(raw)
    const invalid = '<img '.repeat(512) + 'src="" '.repeat(512) + '>'
    expect(resolveGalleryImageSourcesInHtml(invalid, {})).toBe(invalid)
  })
})
