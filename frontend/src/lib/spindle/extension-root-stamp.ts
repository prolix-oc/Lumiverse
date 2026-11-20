const DATA_SCOPE_ATTR = 'data-spindle-ext-id'

type ExtensionUuidAttribute =
  | 'data-spindle-ext'
  | 'data-spindle-extension-root'
  | 'data-spindle-extension-id'

const identities = new Map<string, string>()

/** Manifest identifiers are also used as CSS attribute values. */
export const EXTENSION_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/

/** Register the display/CSS identity for an installed extension UUID. */
export function registerExtensionIdentity(extensionId: string, identifier: string): void {
  identities.set(extensionId, identifier)
}

/** Drop the display/CSS identity when the frontend generation is unloaded. */
export function forgetExtensionIdentity(extensionId: string): void {
  identities.delete(extensionId)
}

/** Return the manifest identifier used by CSS scoping, never an ownership value. */
export function extensionScopeAttrValue(extensionId: string): string | null {
  return identities.get(extensionId) ?? null
}

/**
 * The only host-side writer for extension-owned root attributes.
 * The UUID attribute remains the ownership authority; the identifier is
 * display/CSS metadata only.
 */
export function stampExtensionRoot(
  el: Element,
  extensionId: string,
  uuidAttr: ExtensionUuidAttribute,
): void {
  el.setAttribute(uuidAttr, extensionId)
  const identifier = extensionScopeAttrValue(extensionId)
  if (identifier) el.setAttribute(DATA_SCOPE_ATTR, identifier)
}

export const EXTENSION_ROOT_ATTRIBUTES = new Set([
  'data-spindle-ext',
  'data-spindle-extension-root',
  'data-spindle-extension-id',
  DATA_SCOPE_ATTR,
])
