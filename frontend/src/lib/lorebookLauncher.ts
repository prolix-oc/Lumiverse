import { useStore } from '@/store'
import { hasEnabledFrontendExtension, hasEnabledFrontendExtensionId } from '@/lib/spindle/frontend-extension-availability'

export type LorebookEditorLaunchTarget = 'native' | 'half' | 'full'

type LorebookLaunchSource = 'entry_table' | 'half_editor' | 'settings'

const ACTION_IDS = {
  half: 'lumiverse_suite.lorebook.open_half',
  full: 'lumiverse_suite.lorebook.open_enhanced',
} as const

let invocationSequence = 0

function extensionActionFor(target: Exclude<LorebookEditorLaunchTarget, 'native'>) {
  const actionId = ACTION_IDS[target]
  const state = useStore.getState()
  if (!hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite')) return undefined
  return state.inputBarActions.find((action) =>
    action.contributionId === actionId
    && hasEnabledFrontendExtensionId(state.extensions, action.extensionId)
    && action.enabled
    && action.externallyInvocable !== false
    && action.clickHandlers.size > 0,
  )
}

export function canLaunchLorebookEditor(target: LorebookEditorLaunchTarget): boolean {
  return target !== 'native' && Boolean(extensionActionFor(target))
}

/**
 * Opens an extension-owned lorebook workspace when its action is available.
 * Native navigation remains with the caller so unavailable extensions keep the
 * existing drawer/modal behavior without this low-level helper importing UI.
 */
export function launchLorebookEditor({
  bookId,
  entryId,
  preferredTarget,
  source = 'entry_table',
}: {
  bookId: string
  entryId?: string | null
  preferredTarget?: LorebookEditorLaunchTarget
  source?: LorebookLaunchSource
}): boolean {
  const target = preferredTarget ?? useStore.getState().loreIndicatorSettings.editorLaunchTarget ?? 'native'
  if (target === 'native') return false

  const action = extensionActionFor(target)
  if (!action) return false

  const payload = {
    version: action.payloadVersion ?? 1,
    bookId,
    ...(entryId ? { entryId } : {}),
    source,
    invocationId: `${action.contributionId}:${source === 'half_editor' ? 'lore-indicator' : source}:${++invocationSequence}`,
  }

  let invoked = false
  for (const handler of action.clickHandlers) {
    handler(payload)
    invoked = true
  }
  return invoked
}

export function launchLorebookEditorThen(
  options: Parameters<typeof launchLorebookEditor>[0],
  onLaunched: () => void,
): boolean {
  const launched = launchLorebookEditor(options)
  if (launched) onLaunched()
  return launched
}
