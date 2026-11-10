import { uuidv4, uuidv7 } from '../uuid'

// Mirror the additive public contract until the matching types package ships.
export const SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES = Object.freeze({ 'frontend-uuid-v1': 1 } as const)

export interface SpindleFrontendUUIDAPI {
  v4(): string
  v7(): string
}

/** Generate identifiers locally, including in HTTP browser sessions. */
export function createFrontendUUIDAPI(assertActive: () => void): SpindleFrontendUUIDAPI {
  return Object.freeze({
    v4() {
      assertActive()
      return uuidv4()
    },
    v7() {
      assertActive()
      return uuidv7()
    },
  })
}
