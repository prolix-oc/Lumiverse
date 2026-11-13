interface FrontendExtensionAvailability {
  id?: unknown
  identifier?: unknown
  enabled?: unknown
  has_frontend?: unknown
}

/** Backend commands do not require an extension frontend bundle. */
export function hasEnabledCommandExtensionId(extensions: readonly FrontendExtensionAvailability[] | null | undefined, id: string): boolean {
  return Boolean(extensions?.some(extension => extension.id === id && extension.enabled === true))
}

export function filterEnabledCommandContributions<T extends { extensionId: string }>(contributions: readonly T[], extensions: readonly FrontendExtensionAvailability[] | null | undefined): T[] {
  return contributions.filter(entry => hasEnabledCommandExtensionId(extensions, entry.extensionId))
}

function isEnabledFrontendExtension(extension: FrontendExtensionAvailability): boolean {
  return extension.enabled === true && extension.has_frontend === true
}

/** True only while the named extension frontend is installed and available to mount. */
export function hasEnabledFrontendExtension(
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
  identifier: string,
): boolean {
  return Boolean(extensions?.some((extension) => (
    extension.identifier === identifier
    && isEnabledFrontendExtension(extension)
  )))
}

/** True only while the extension that owns a frontend contribution can run. */
export function hasEnabledFrontendExtensionId(
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
  extensionId: string,
): boolean {
  return Boolean(extensions?.some((extension) => (
    extension.id === extensionId && isEnabledFrontendExtension(extension)
  )))
}

/** Remove stale contributions whose owning frontend is disabled or unavailable. */
export function filterEnabledFrontendContributions<T extends { extensionId: string }>(
  contributions: readonly T[],
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
): T[] {
  const enabledIds = new Set(
    extensions
      ?.filter(isEnabledFrontendExtension)
      .map((extension) => extension.id)
      .filter((id): id is string => typeof id === 'string')
      ?? [],
  )
  return contributions.filter((contribution) => enabledIds.has(contribution.extensionId))
}

/** A retained Suite DOM root cannot keep claiming a native surface after disable/uninstall. */
export function hasAvailableFrontendSurface(
  root: ParentNode,
  selector: string,
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
): boolean {
  return [...root.querySelectorAll(selector)].some((element) => {
    const owner = element.closest('[data-spindle-ext-id], [data-spindle-extension-root], [data-spindle-ext]')
    const identifier = owner?.getAttribute('data-spindle-ext-id')
    if (identifier) return hasEnabledFrontendExtension(extensions, identifier)
    const extensionId = owner?.getAttribute('data-spindle-extension-root') ?? owner?.getAttribute('data-spindle-ext')
    return Boolean(extensionId && hasEnabledFrontendExtensionId(extensions, extensionId))
  })
}
