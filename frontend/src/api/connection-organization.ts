import { get } from './client'
import { wsClient, WS_OPEN } from '@/ws/client'
import { assertOrganizationKind, organizationError, organizationInvalidated, watchConnectionOrganization, type ConnectionOrganizationAPI,
  type ConnectionOrganizationSnapshot } from '../../../src/shared/connection-organization'

const events = [WS_OPEN, 'USER_IMPORT_COMPLETE', 'SETTINGS_UPDATED', 'CONNECTION_PROFILE_LOADED', 'IMAGE_GEN_CONNECTION_CHANGED',
  'TTS_CONNECTION_CHANGED', 'STT_CONNECTION_CHANGED', 'DECISION_CONNECTION_CHANGED', 'CONNECTION_ORGANIZATION_CHANGED']
export const connectionOrganizationApi: ConnectionOrganizationAPI = {
  async get({ kind }) {
    assertOrganizationKind(kind)
    try { return await get<ConnectionOrganizationSnapshot>(`/connections/organization/${kind}`) }
    catch (error) { throw organizationError(error) }
  },
  watch({ kind }, handler, onError = error => console.error('[connection-organization]', error)) {
    assertOrganizationKind(kind)
    return watchConnectionOrganization(() => connectionOrganizationApi.get({ kind }), refresh => {
      const removers = events.map(event => wsClient.on(event, payload => { if (organizationInvalidated(kind, event, payload)) refresh() }))
      return () => removers.forEach(remove => remove())
    }, handler, error => onError(organizationError(error)))
  },
}
