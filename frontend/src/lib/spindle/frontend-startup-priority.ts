import type { ExtensionInfo } from 'lumiverse-spindle-types'

export const HOMEPAGE_EXTENSION_IDENTIFIER = 'lumiverse_suite'

type FrontendHydrationCandidate = Pick<
  ExtensionInfo,
  'enabled' | 'has_frontend' | 'granted_permissions' | 'identifier' | 'installed_at'
>

function frontendHydrationPriority(extension: FrontendHydrationCandidate): number {
  if (!extension.enabled || !extension.has_frontend) return -1
  if (extension.identifier === HOMEPAGE_EXTENSION_IDENTIFIER) return 2
  if (
    extension.granted_permissions.includes('ui_panels')
    || extension.granted_permissions.includes('app_manipulation')
  ) return 1
  return 0
}

export function compareFrontendHydrationPriority(
  left: FrontendHydrationCandidate,
  right: FrontendHydrationCandidate,
): number {
  const priorityDifference = frontendHydrationPriority(right) - frontendHydrationPriority(left)
  return priorityDifference || right.installed_at - left.installed_at
}
