import { createSuite } from './suite'
import { installThemeBridge } from './shared/theme'
import { createLoreIndicatorModule } from './modules/lore_indicator'
import { createQuickToolbarModule } from './modules/quick_toolbar'
import { createConnectionsPickerModule } from './modules/connections_picker'
import { createCharacterLibraryScopeModule } from './modules/character_library_scope'
import { createCharacterDisplayModule } from './modules/character_display'
import { createPortraitDockModule } from './modules/portrait_dock'
import { createLorebookTokenCountsModule } from './modules/lorebook_token_counts'
import { createLorebookWorkspaceModule } from './modules/lorebook_workspace'
import { createHomepageLibraryModule } from './modules/homepage_library'
import type { SuiteHostContext } from './suite'

/**
 * Starts the suite lifecycle. Registry inclusion bootstraps modules so each
 * module can own its private enabled setting.
 */
export async function setup(
  ctx: SuiteHostContext,
): Promise<() => Promise<void>> {
  const disposeThemeBridge = installThemeBridge(css => ctx.dom.addStyle(css), ctx)
  const suite = createSuite(ctx, [
    { module: createQuickToolbarModule(ctx), enabled: true },
    { module: createLoreIndicatorModule(ctx), enabled: true },
    { module: createConnectionsPickerModule(), enabled: true },
    { module: createPortraitDockModule(), enabled: true },
    { module: createCharacterDisplayModule(), enabled: true },
    { module: createCharacterLibraryScopeModule(), enabled: true },
    { module: createLorebookTokenCountsModule(), enabled: true },
    { module: createLorebookWorkspaceModule(), enabled: true },
    { module: createHomepageLibraryModule(), enabled: true },
  ])

  let teardownStarted = false
  let unregisterHostTeardown: (() => void) | undefined
  const teardown = async (): Promise<void> => {
    if (teardownStarted) return
    teardownStarted = true
    try {
      await suite.stop()
    } finally {
      try {
        unregisterHostTeardown?.()
      } finally {
        unregisterHostTeardown = undefined
        disposeThemeBridge()
      }
    }
  }
  const hostTeardown = (): Promise<void> => teardown().catch(error => {
    console.error('[Lumiverse Suite] Host teardown failed:', error)
  })

  try {
    await suite.start()
    unregisterHostTeardown = ctx.onTeardown?.(hostTeardown)
  } catch (error) {
    try {
      await teardown()
    } catch {
      // Preserve the setup failure; teardown is best effort on this path.
    }
    throw error
  }

  return teardown
}
