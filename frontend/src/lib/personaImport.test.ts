import { describe, expect, it } from 'bun:test'

import {
  parsePersonaExportPayload,
  PersonaImportFormatError,
  PERSONA_EXPORT_TYPE,
  PERSONA_EXPORT_VERSION,
} from './personaImport'

describe('parsePersonaExportPayload', () => {
  it('accepts the wrapper produced by persona bulk export', () => {
    const personas = [
      {
        id: 'source-id',
        name: 'The Archivist',
        description: 'Keeps careful records.',
        subjective_pronoun: 'she',
        is_narrator: true,
      },
    ]

    expect(parsePersonaExportPayload({
      type: PERSONA_EXPORT_TYPE,
      version: PERSONA_EXPORT_VERSION,
      exported_at: '2026-07-28T00:00:00.000Z',
      personas,
    })).toBe(personas)
  })

  it('rejects unrelated JSON and unsupported export versions', () => {
    expect(() => parsePersonaExportPayload({ personas: [{ name: 'No wrapper' }] }))
      .toThrow(new PersonaImportFormatError('invalid_export'))
    expect(() => parsePersonaExportPayload({
      type: PERSONA_EXPORT_TYPE,
      version: 99,
      personas: [{ name: 'Future persona' }],
    })).toThrow(new PersonaImportFormatError('unsupported_version'))
  })

  it('rejects an empty persona export', () => {
    expect(() => parsePersonaExportPayload({
      type: PERSONA_EXPORT_TYPE,
      version: PERSONA_EXPORT_VERSION,
      personas: [],
    })).toThrow(new PersonaImportFormatError('empty_export'))
  })
})
