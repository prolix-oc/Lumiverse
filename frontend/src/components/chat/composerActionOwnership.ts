const SUITE_OWNED_COMPOSER_ACTION_IDS = new Set([
  'chat.authors-note',
  'chat.manage',
  'chat.settings',
  'settings',
  'connectionsPicker',
])

/** Host actions that have a permanent native presentation in the composer. */
const CORE_OWNED_COMPOSER_ACTION_IDS = new Set([
  'chat.customize-composer',
])

export function isCoreOwnedComposerActionId(id: string): boolean {
  return CORE_OWNED_COMPOSER_ACTION_IDS.has(id)
}

/** Returns true for composer entries supplied by Suite or another extension. */
export function isExtensionComposerActionId(id: string): boolean {
  return SUITE_OWNED_COMPOSER_ACTION_IDS.has(id)
    || id.startsWith('spindle:')
    || id.startsWith('input-action:')
    || id.startsWith('ext-cmd-')
    || id.startsWith('ext-tab-')
    || id.startsWith('ext-action:')
    || id.startsWith('ext-runtime:')
    || id.startsWith('lumiverse_suite.')
}
