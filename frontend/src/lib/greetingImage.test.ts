import { describe, expect, test } from 'bun:test'
import type { Character, Message } from '@/types/api'
import {
  containsGreetingImageMarkup,
  findEmbeddedGreetingImageSource,
  getGreetingCellImageUrl,
  getGreetingMessageCharacterId,
  getGreetingMessageImage,
  removeGreetingImageMarkup,
  resolveEmbeddedGreetingImage,
  resolveGreetingMessageIndex,
} from './greetingImage'

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'character-1',
    first_mes: 'Main greeting',
    alternate_greetings: ['Alternate greeting'],
    extensions: { greeting_backgrounds: { 0: 'main-art', 1: 'alternate-art' } },
    ...overrides,
  } as Character
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    index_in_chat: 0,
    is_user: false,
    content: 'Main greeting',
    extra: { greeting: true, greeting_index: 0, greeting_character_id: 'character-1' },
    ...overrides,
  } as Message
}

describe('greeting images', () => {
  test('recognizes and selects the first embedded greeting image', () => {
    const content = [
      'Opening text ![scene](https://images.example/scene.webp)',
      '<img src="https://images.example/later.png">',
    ].join('\n')

    expect(containsGreetingImageMarkup(content)).toBe(true)
    expect(findEmbeddedGreetingImageSource(content)).toBe('https://images.example/scene.webp')
  })

  test('resolves gallery and Risu image references through the character asset map', () => {
    expect(resolveEmbeddedGreetingImage(
      '![Scene](gallery://image-2)',
      { 'gallery://image-2': 'gallery-image-id' },
    )).toEqual({ imageId: 'gallery-image-id' })

    expect(resolveEmbeddedGreetingImage(
      '<img="embeded://opening.webp">',
      { opening: 'risu-image-id' },
    )).toEqual({ imageId: 'risu-image-id' })
  })

  test('uses embedded art as a fallback while explicit greeting art takes precedence', () => {
    const character = {
      extensions: {
        greeting_backgrounds: { 0: 'explicit-image-id' },
        risu_asset_map: { 'gallery://image-1': 'embedded-image-id' },
      },
    } as unknown as Character
    const content = '![Opening](gallery://image-1)'

    expect(getGreetingCellImageUrl(character, 0, content)).toContain('/images/explicit-image-id?size=sm')
    expect(getGreetingCellImageUrl(character, 1, content)).toContain('/images/embedded-image-id?size=sm')
  })

  test('resolves alternate greeting art from stored metadata at original quality', () => {
    const image = getGreetingMessageImage(makeCharacter(), makeMessage({
      content: 'Edited greeting',
      extra: { greeting: true, greeting_index: 1 },
    }))

    expect(image).toEqual({ url: '/api/v1/images/alternate-art', greetingIndex: 1 })
    expect(image?.url).not.toContain('size=')
  })

  test('recovers a greeting index from imported content before using chat metadata', () => {
    expect(resolveGreetingMessageIndex(makeCharacter(), makeMessage({
      content: ' Alternate greeting\r\n',
      extra: {},
    }), { activeGreetingIndex: 0 })).toBe(1)
  })

  test('uses the selected index when multiple greetings have identical text', () => {
    const character = makeCharacter({ alternate_greetings: ['Main greeting'] })
    expect(resolveGreetingMessageIndex(character, makeMessage({ extra: {} }), { activeGreetingIndex: 1 })).toBe(1)
  })

  test('keeps associated art after greetings were reordered or an earlier greeting was removed', () => {
    const message = makeMessage({ content: 'Alternate greeting', extra: { greeting_index: 1 } })
    const reordered = makeCharacter({
      alternate_greetings: ['Another greeting', 'Alternate greeting'],
      extensions: { greeting_backgrounds: { 1: 'another-art', 2: 'alternate-art' } },
    })
    expect(getGreetingMessageImage(reordered, message)).toEqual({
      url: '/api/v1/images/alternate-art', greetingIndex: 2,
    })

    const shifted = makeCharacter({
      alternate_greetings: ['Alternate greeting', 'Another greeting'],
      extensions: { greeting_backgrounds: { 1: 'alternate-art', 2: 'another-art' } },
    })
    expect(getGreetingMessageImage(shifted, { ...message, extra: { greeting_index: 2 } })).toEqual({
      url: '/api/v1/images/alternate-art', greetingIndex: 1,
    })
  })

  test('retains stored indices for duplicate or manually edited greeting content', () => {
    const character = makeCharacter({ alternate_greetings: ['Main greeting'] })
    expect(resolveGreetingMessageIndex(character, makeMessage({ extra: { greeting_index: 1 } }))).toBe(1)
    expect(resolveGreetingMessageIndex(character, makeMessage({
      content: 'Manually edited greeting', extra: { greeting_index: 1 },
    }))).toBe(1)
  })

  test('rejects invalid stored indices and scopes group fallback to the greeting owner', () => {
    const message = makeMessage({ content: 'Edited greeting', extra: { greeting_index: -1 } })
    expect(resolveGreetingMessageIndex(makeCharacter(), message, { activeGreetingIndex: 1 })).toBe(1)
    expect(resolveGreetingMessageIndex(makeCharacter(), message, {
      group: true,
      activeGreetingIndex: 1,
      group_active_greeting_indices: { 'another-character': 1 },
    })).toBe(0)
    expect(resolveGreetingMessageIndex(makeCharacter(), message, {
      group: true,
      group_active_greeting_indices: { 'character-1': 1 },
    })).toBe(1)
    expect(resolveGreetingMessageIndex(makeCharacter(), message, { activeGreetingIndex: 200 })).toBe(0)
  })

  test('preserves the greeting owner after changing the active character', () => {
    const message = makeMessage()
    expect(getGreetingMessageCharacterId(message, 'another-character')).toBe('character-1')
    expect(getGreetingMessageCharacterId(makeMessage({ extra: {} }), 'another-character')).toBe('another-character')
    expect(getGreetingMessageImage(makeCharacter({ id: 'another-character' }), message)).toBeNull()
  })

  test('limits artwork to the opening assistant message', () => {
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({ index_in_chat: 3 }))).toBeNull()
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({ is_user: true }))).toBeNull()
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({ extra: {} }))).not.toBeNull()
    expect(getGreetingMessageImage(makeCharacter({ extensions: {} }), makeMessage())).toBeNull()
  })

  test('ignores an unmarked first assistant reply that is not the greeting', () => {
    const regenerated = makeMessage({ content: 'Regenerated opening', extra: {} })
    expect(getGreetingMessageImage(makeCharacter(), regenerated, { activeGreetingIndex: 0 })).toBeNull()
    expect(getGreetingMessageImage(makeCharacter(), { ...regenerated, extra: { greeting: false } })).toBeNull()
  })

  test('keeps greeting art for marked, indexed, or content-matched legacy messages', () => {
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({
      content: 'Regenerated opening',
      extra: { greeting: true, greeting_index: 0 },
    }))).not.toBeNull()
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({
      content: 'Edited legacy greeting',
      extra: { greeting_index: 1 },
    }))).not.toBeNull()
    expect(getGreetingMessageImage(makeCharacter(), makeMessage({ extra: {} }))).not.toBeNull()
  })

  test('uses embedded gallery art when the greeting has no explicit association', () => {
    const content = '![Scene](gallery://opening)\nOpening text'
    const character = makeCharacter({
      first_mes: content,
      extensions: { risu_asset_map: { 'gallery://opening': 'gallery-art' } },
    })

    expect(getGreetingMessageImage(character, makeMessage({ content }))).toEqual({
      url: '/api/v1/images/gallery-art',
      greetingIndex: 0,
      embeddedSource: 'gallery://opening',
    })
  })

  test('only marks matching inline art for removal when an explicit association exists', () => {
    const content = '<img="embeded://opening.webp">\nOpening text'
    const character = makeCharacter({
      extensions: {
        greeting_backgrounds: { 0: 'main-art' },
        risu_asset_map: { opening: 'different-art' },
      },
    })
    expect(getGreetingMessageImage(character, makeMessage({ content }))).toEqual({
      url: '/api/v1/images/main-art', greetingIndex: 0,
    })
    character.extensions.risu_asset_map.opening = 'main-art'
    expect(getGreetingMessageImage(character, makeMessage({ content }))?.embeddedSource).toBe('embeded://opening.webp')
  })

  test('can resolve selected greeting art after inline markup was transformed away', () => {
    const character = makeCharacter({
      first_mes: '![Scene](https://images.example/opening.webp)\nOpening text',
      extensions: {},
    })
    expect(getGreetingMessageImage(character, makeMessage({ content: 'Opening text' }))).toEqual({
      url: '/api/v1/images/remote?url=https%3A%2F%2Fimages.example%2Fopening.webp', greetingIndex: 0,
    })
  })

  test('proxies promoted remote art so HTTP sources still work in HTTPS chats', () => {
    const content = '![Scene](http://images.example/opening.webp) Opening text'
    expect(getGreetingMessageImage(makeCharacter({ extensions: {} }), makeMessage({ content }))).toEqual({
      url: '/api/v1/images/remote?url=http%3A%2F%2Fimages.example%2Fopening.webp',
      greetingIndex: 0,
      embeddedSource: 'http://images.example/opening.webp',
    })
  })

  test('keeps local, data and blob image sources direct', () => {
    for (const source of ['/api/v1/images/local-art', 'data:image/png;base64,aGVsbG8=', 'blob:http://localhost/image']) {
      const content = `![Scene](${source}) Opening text`
      expect(getGreetingMessageImage(makeCharacter({ extensions: {} }), makeMessage({ content }))?.url).toBe(source)
    }
  })

  test('keeps same-origin absolute sources direct and proxies third-party protocol-relative sources', () => {
    const previousWindow = globalThis.window
    Object.assign(globalThis, { window: { location: { origin: 'https://lumiverse.example' } } })
    try {
      const character = makeCharacter({ extensions: {} })
      const localSource = 'https://lumiverse.example/api/v1/images/local-art'
      expect(getGreetingMessageImage(character, makeMessage({ content: `![Scene](${localSource})` }))?.url).toBe(localSource)
      expect(getGreetingMessageImage(character, makeMessage({ content: '![Scene](//images.example/scene.webp)' }))?.url)
        .toBe('/api/v1/images/remote?url=https%3A%2F%2Fimages.example%2Fscene.webp')
    } finally {
      Object.assign(globalThis, { window: previousWindow })
    }
  })

  test('removes only the first matching image while preserving surrounding markup', () => {
    const content = '<figure class="scene"><img src="scene.webp" style="width: 100%"></figure>\n![Again](scene.webp)\nText ![Other](other.webp)'
    expect(removeGreetingImageMarkup(content, 'scene.webp')).toBe(
      '<figure class="scene"></figure>\n![Again](scene.webp)\nText ![Other](other.webp)',
    )
    expect(removeGreetingImageMarkup(content, 'missing.webp')).toBe(content)
    expect(removeGreetingImageMarkup('Text ![Scene](<scene.webp> "Caption") after', 'scene.webp')).toBe('Text  after')
    expect(removeGreetingImageMarkup('<img="embeded://opening.webp"> Opening', 'embeded://opening.webp')).toBe(' Opening')
  })

  test('reads the real image source when author markup also has data attributes', () => {
    const content = '<img data-src="placeholder.webp" src="scene.webp" data-fallback-src="fallback.webp">'
    expect(findEmbeddedGreetingImageSource(content)).toBe('scene.webp')
    expect(removeGreetingImageMarkup(content, 'fallback.webp')).toBe(content)
    expect(removeGreetingImageMarkup(content, 'scene.webp')).toBe('')
  })
})
