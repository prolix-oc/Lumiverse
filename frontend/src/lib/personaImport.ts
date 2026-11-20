export const PERSONA_EXPORT_TYPE = 'lumiverse_personas'
export const PERSONA_EXPORT_VERSION = 1

export type PersonaImportFormatErrorCode =
  | 'invalid_export'
  | 'unsupported_version'
  | 'empty_export'

export class PersonaImportFormatError extends Error {
  constructor(public readonly code: PersonaImportFormatErrorCode) {
    super(code)
    this.name = 'PersonaImportFormatError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the wrapper produced by Persona Manager's bulk export action.
 * Individual persona validation is handled by the server so one malformed
 * entry can be reported without blocking the rest of the file.
 */
export function parsePersonaExportPayload(payload: unknown): unknown[] {
  if (!isRecord(payload) || payload.type !== PERSONA_EXPORT_TYPE || !Array.isArray(payload.personas)) {
    throw new PersonaImportFormatError('invalid_export')
  }
  if (payload.version !== PERSONA_EXPORT_VERSION) {
    throw new PersonaImportFormatError('unsupported_version')
  }
  if (payload.personas.length === 0) {
    throw new PersonaImportFormatError('empty_export')
  }
  return payload.personas
}
