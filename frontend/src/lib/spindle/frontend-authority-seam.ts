/**
 * Integration seam for the shared frontend authority registry.
 *
 * Unknown bridge leaves remain fail-closed. Production installs the resolver
 * below, which projects the one canonical authority map used by the loader,
 * state selectors, and domain boundary.
 */

import { frontendAuthorityRowFor } from './frontend-authority-map'

export interface FrontendAuthorityResolution {
  readonly permission: string | null
}

export type FrontendAuthorityResolver = (id: string) => FrontendAuthorityResolution

export const AUTHORITY_MAP_NOT_INTEGRATED = 'spindle_authority_map_unwired'

export const failClosedFrontendAuthorityResolver: FrontendAuthorityResolver = () => ({
  permission: AUTHORITY_MAP_NOT_INTEGRATED,
})

export const canonicalFrontendAuthorityResolver: FrontendAuthorityResolver = (id) => {
  const row = frontendAuthorityRowFor({ surface: 'state_selector', id })
    ?? frontendAuthorityRowFor({ surface: 'ctx_member', id })
    ?? frontendAuthorityRowFor({ surface: 'legacy_ctx_member', id })
  // A free row carries `permission: null`, which must stay free rather than fall through to fail-closed.
  return { permission: row ? row.permission : AUTHORITY_MAP_NOT_INTEGRATED }
}

let activeFrontendAuthorityResolver: FrontendAuthorityResolver = canonicalFrontendAuthorityResolver

/** The authority-map lane may install its resolver without changing H2/H10. */
export function installFrontendAuthorityResolver(resolver: FrontendAuthorityResolver): void {
  activeFrontendAuthorityResolver = resolver
}

export function resolveFrontendAuthority(id: string): FrontendAuthorityResolution {
  return activeFrontendAuthorityResolver(id)
}
