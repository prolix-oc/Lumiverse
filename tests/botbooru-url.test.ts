import { describe, expect, test } from 'bun:test'
import { parseBotBooruId, botBooruDownloadUrl, rewriteBotBooruUrl } from '../src/utils/botbooru'

describe('parseBotBooruId', () => {
  test('parses the browseable character + post URLs', () => {
    expect(parseBotBooruId('https://botbooru.com/character/12345')).toBe('12345')
    expect(parseBotBooruId('https://botbooru.com/post/12345')).toBe('12345')
  })

  test('parses the download URLs', () => {
    expect(parseBotBooruId('https://botbooru.com/download/png/abc-123')).toBe('abc-123')
    expect(parseBotBooruId('https://botbooru.com/download/json/abc-123')).toBe('abc-123')
  })

  test('accepts www and trailing slashes / query strings', () => {
    expect(parseBotBooruId('https://www.botbooru.com/character/42/')).toBe('42')
    expect(parseBotBooruId('https://botbooru.com/post/42?foo=bar')).toBe('42')
    expect(parseBotBooruId('  https://botbooru.com/character/42  ')).toBe('42')
  })

  test('rejects other hosts and unrecognized paths', () => {
    expect(parseBotBooruId('https://chub.ai/characters/foo/bar')).toBeNull()
    expect(parseBotBooruId('https://example.com/character/1')).toBeNull()
    expect(parseBotBooruId('https://botbooru.com/')).toBeNull()
    expect(parseBotBooruId('https://botbooru.com/character')).toBeNull()
    expect(parseBotBooruId('https://botbooru.com/download/webp/1')).toBeNull()
    expect(parseBotBooruId('not a url')).toBeNull()
  })

  test('rejects host look-alikes and non-http(s) schemes', () => {
    expect(parseBotBooruId('https://botbooru.com.evil.test/character/1')).toBeNull()
    expect(parseBotBooruId('https://notbotbooru.com/character/1')).toBeNull()
    expect(parseBotBooruId('ftp://botbooru.com/character/1')).toBeNull()
  })

  test('rejects ids with path-injection characters', () => {
    expect(parseBotBooruId('https://botbooru.com/character/..%2F..%2Fadmin')).toBeNull()
    expect(parseBotBooruId('https://botbooru.com/character/a%20b')).toBeNull()
  })
})

describe('botBooruDownloadUrl', () => {
  test('builds canonical download URLs', () => {
    expect(botBooruDownloadUrl('42', 'png')).toBe('https://botbooru.com/download/png/42')
    expect(botBooruDownloadUrl('42', 'json')).toBe('https://botbooru.com/download/json/42')
  })
})

describe('rewriteBotBooruUrl', () => {
  test('rewrites any recognized shape to the requested format', () => {
    expect(rewriteBotBooruUrl('https://botbooru.com/character/7', 'png')).toBe(
      'https://botbooru.com/download/png/7',
    )
    expect(rewriteBotBooruUrl('https://botbooru.com/post/7', 'json')).toBe(
      'https://botbooru.com/download/json/7',
    )
    // A json download URL can be re-pointed to png (characters prefer the avatar-bearing PNG).
    expect(rewriteBotBooruUrl('https://botbooru.com/download/json/7', 'png')).toBe(
      'https://botbooru.com/download/png/7',
    )
  })

  test('returns null for non-BotBooru URLs so callers fall through', () => {
    expect(rewriteBotBooruUrl('https://chub.ai/characters/foo/bar', 'png')).toBeNull()
  })
})
