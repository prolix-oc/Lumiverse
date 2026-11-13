import { describe, expect, test } from 'bun:test'
import {
  chubSourceUrl,
  parseCharacterSourceInput,
  parseChubSourceInput,
  readCharacterSourceUrl,
  readChubFullPath,
  setCharacterSource,
  setChubFullPath,
} from './characterSource'

describe('character source attribution', () => {
  test('reads current, legacy, and Lumiverse fallback paths', () => {
    expect(readChubFullPath({ chub: { full_path: '/creator/card/' } })).toBe('creator/card')
    expect(readChubFullPath({ chub: { fullPath: 'legacy/card' } })).toBe('legacy/card')
    expect(readChubFullPath({ _lumiverse_chub_slug: 'fallback/card' })).toBe('fallback/card')
    expect(readChubFullPath({ chub: { full_path: 'https://chub.ai/characters/url/card' } })).toBe('url/card')
  })

  test('accepts supported source URLs and portable paths', () => {
    expect(parseChubSourceInput('https://chub.ai/characters/Creator/Card?view=full')).toBe('Creator/Card')
    expect(parseChubSourceInput('https://characterhub.org/characters/Creator/Card/')).toBe('Creator/Card')
    expect(parseChubSourceInput('chub.ai/characters/Creator/Card')).toBe('Creator/Card')
    expect(parseChubSourceInput('characters/Creator/Card')).toBe('Creator/Card')
    expect(parseChubSourceInput('Creator/Card')).toBe('Creator/Card')
    expect(chubSourceUrl('Creator/Card')).toBe('https://chub.ai/characters/Creator/Card')
  })

  test('rejects unsupported or incomplete sources', () => {
    expect(parseChubSourceInput('https://example.com/characters/Creator/Card')).toBeNull()
    expect(parseChubSourceInput('ftp://chub.ai/characters/Creator/Card')).toBeNull()
    expect(parseChubSourceInput('https://chub.ai/characters/Creator')).toBeNull()
    expect(parseChubSourceInput('not-a-source')).toBeNull()
  })

  test('updates source fields without discarding extension metadata', () => {
    const next = setChubFullPath({
      unrelated: { keep: true },
      _lumiverse_chub_slug: 'old/card',
      chub: { fullPath: 'old/card', description: 'keep' },
    }, 'new/card')

    expect(next).toEqual({
      unrelated: { keep: true },
      _lumiverse_chub_slug: 'new/card',
      chub: { full_path: 'new/card', description: 'keep' },
    })
  })

  test('clears source fields without discarding other Chub metadata', () => {
    const next = setChubFullPath({
      unrelated: true,
      _lumiverse_chub_slug: 'old/card',
      chub: { full_path: 'old/card', description: 'keep' },
    }, null)

    expect(next).toEqual({
      unrelated: true,
      chub: { description: 'keep' },
    })
  })

  test.each([
    ['https://lumi.spot/@archkr', 'lumihub', 'https://lumi.spot/@archkr'],
    ['lumi.spot/@archkr', 'lumihub', 'https://lumi.spot/@archkr'],
    [' https://LUMI.SPOT/characters/card-id?view=full#details ', 'lumihub', 'https://lumi.spot/characters/card-id?view=full#details'],
    ['https://www.lumi.spot/characters/card-id/', 'lumihub', 'https://www.lumi.spot/characters/card-id/'],
    ['https://illarin.com/a/card-id/card-name', 'illarin', 'https://illarin.com/a/card-id/card-name'],
    ['illarin.com/a/card-id/card-name', 'illarin', 'https://illarin.com/a/card-id/card-name'],
    ['https://www.illarin.com/@creator', 'illarin', 'https://www.illarin.com/@creator'],
    ['//illarin.com/a/card-id/card-name?version=2#details', 'illarin', 'https://illarin.com/a/card-id/card-name?version=2#details'],
  ] as const)('preserves hub source %s through saving and reloading', (input, provider, url) => {
    const source = parseCharacterSourceInput(input)
    expect(source).toEqual({ provider, url })
    const extensions = setCharacterSource({ unrelated: { keep: true } }, source)
    expect(extensions).toEqual({ unrelated: { keep: true }, _lumiverse_source_url: url })
    expect(readCharacterSourceUrl(JSON.parse(JSON.stringify(extensions)))).toBe(url)
  })

  test.each([
    'https://chub.ai/characters/Creator/Card?view=full',
    'https://characterhub.org/characters/Creator/Card/',
    'chub.ai/characters/Creator/Card',
    'characters/Creator/Card',
    'Creator/Card',
  ])('keeps Chub source compatibility for %s', (input) => {
    const source = parseCharacterSourceInput(input)
    expect(source).toEqual({ provider: 'chub', fullPath: 'Creator/Card', url: 'https://chub.ai/characters/Creator/Card' })
    const extensions = setCharacterSource({}, source)
    expect(extensions).toEqual({ chub: { full_path: 'Creator/Card' } })
    expect(readCharacterSourceUrl(extensions)).toBe('https://chub.ai/characters/Creator/Card')
  })

  test.each([
    '',
    'not-a-source',
    'https://lumi.spot/',
    'https://illarin.com/',
    'https://chub.ai/characters/Creator',
    'https://lumi.spot.evil.example/@archkr',
    'https://example.com/characters/card',
    'https://lumi.spot@evil.example/@archkr',
    'https://someone:secret@illarin.com/a/card-id/card-name',
    'ftp://lumi.spot/@archkr',
    'javascript:alert(1)//card',
    'https://[invalid]/card',
  ])('rejects invalid source %s', (input) => {
    expect(parseCharacterSourceInput(input)).toBeNull()
  })

  test('reads legacy Chub sources and ignores invalid explicit source metadata', () => {
    expect(readCharacterSourceUrl({ chub: { fullPath: 'legacy/card' } })).toBe('https://chub.ai/characters/legacy/card')
    expect(readCharacterSourceUrl({ _lumiverse_chub_slug: 'fallback/card' })).toBe('https://chub.ai/characters/fallback/card')
    expect(readCharacterSourceUrl({
      _lumiverse_source_url: 'javascript:alert(1)',
      chub: { full_path: 'fallback/card' },
    })).toBe('https://chub.ai/characters/fallback/card')
    expect(readCharacterSourceUrl({ _lumiverse_source_url: 42 })).toBeNull()
    expect(readCharacterSourceUrl(null)).toBeNull()
  })

  test('switches providers and clears attribution without losing other metadata', () => {
    const original = {
      unrelated: { keep: true },
      _lumiverse_chub_slug: 'old/card',
      chub: { full_path: 'old/card', fullPath: 'older/card', description: 'keep' },
    }
    const lumi = setCharacterSource(original, parseCharacterSourceInput('https://lumi.spot/@archkr'))
    expect(lumi).toEqual({
      unrelated: { keep: true },
      chub: { description: 'keep' },
      _lumiverse_source_url: 'https://lumi.spot/@archkr',
    })
    expect(original.chub.full_path).toBe('old/card')
    expect(original._lumiverse_chub_slug).toBe('old/card')

    const illarin = setCharacterSource(lumi, parseCharacterSourceInput('https://illarin.com/a/card-id/card-name'))
    expect(readCharacterSourceUrl(illarin)).toBe('https://illarin.com/a/card-id/card-name')

    const chub = setCharacterSource(illarin, parseCharacterSourceInput('new/card'))
    expect(chub).toEqual({ unrelated: { keep: true }, chub: { description: 'keep', full_path: 'new/card' } })
    for (const extensions of [lumi, illarin, chub]) {
      const cleared = setCharacterSource(extensions, null)
      expect(cleared).toEqual({ unrelated: { keep: true }, chub: { description: 'keep' } })
      expect(readCharacterSourceUrl(cleared)).toBeNull()
    }
  })
})
