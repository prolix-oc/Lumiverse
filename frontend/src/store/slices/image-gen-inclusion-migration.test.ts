/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { migrateStoredImageGeneration } from './settings'

describe('image generation inclusion migration', () => {
  test('maps the legacy combined switch to both independent switches', () => {
    expect(migrateStoredImageGeneration({ includeCharacters: true })).toEqual({
      includeCharacters: true,
      includePersona: true,
    })
    expect(migrateStoredImageGeneration({ includeCharacters: false })).toEqual({
      includeCharacters: false,
      includePersona: false,
    })
  })

  test('preserves an explicit persona choice', () => {
    expect(migrateStoredImageGeneration({
      includeCharacters: true,
      includePersona: false,
    })).toEqual({
      includeCharacters: true,
      includePersona: false,
    })
  })
})
