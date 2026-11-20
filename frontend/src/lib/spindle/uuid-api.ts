import { SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES, type SpindleFrontendUUIDAPI } from 'lumiverse-spindle-types'
import { uuidv4, uuidv7 } from '../uuid'

export { SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES, type SpindleFrontendUUIDAPI }

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
