import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@/store'
import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { isDesktopFloatingWidgetWindow } from '@/lib/desktop-floating-widget'
import type { Command } from '@/lib/commands'
import { filterEnabledCommandContributions } from '@/lib/spindle/frontend-extension-availability'
import { commandScopeActive, matchingBinding, type DesktopBinding, type KeybindingTrigger } from '@/lib/desktop-keybindings'

export function useDesktopKeybindings() {
  const navigate = useNavigate()
  const location = useLocation()
  const account = useStore(s => s.user?.id)
  const role = useStore(s => s.user?.role)
  const extensionCommands = useStore(s => s.extensionCommands)
  const extensions = useStore(s => s.extensions)
  const settingsTabs = useStore(s => s.settingsTabs)
  const current = useRef({ commands: [] as Command[], path: location.pathname, navigate })
  const publishQueue = useRef<Promise<unknown>>(Promise.resolve())
  current.current.path = location.pathname
  current.current.navigate = navigate

  useEffect(() => {
    if (!hasTauriDesktopBridge() || isDesktopFloatingWidgetWindow()) return
    let disposed = false
    let revision = 0
    let bindings: DesktopBinding[] = []
    const stops: Array<() => void> = []
    void settingsTabs
    const publish = () => {
      const own = ++revision
      const args = { accountId: account ?? '', commands: current.current.commands.map(({ id, label }) => ({ id, label })) }
      // Native mutation order matters too: ignoring an old result cannot undo a stale catalog.
      const pending = publishQueue.current.catch(() => {}).then(async () => {
        if (disposed || own !== revision) return
        const result = await invoke<DesktopBinding[]>('desktop_keybindings_publish', args)
        if (!disposed && own === revision) bindings = result
      })
      publishQueue.current = pending
      return pending
    }
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-desktop-keybinding-editor]')) return
      const binding = matchingBinding(bindings, event)
      if (!binding) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat || binding.scope === 'global') return
      void invoke('desktop_keybindings_trigger', { id: binding.id }).catch(() => {})
    }
    const watch = async () => {
      // Keep command/panel modules out of browser and mobile startup.
      const [{ buildCommands }, { extensionCommandsToCommands }] = await Promise.all([
        import('@/lib/commands'), import('@/lib/drawer-tab-registry'),
      ])
      if (disposed) return
      current.current.commands = account ? [...buildCommands(role), ...extensionCommandsToCommands(filterEnabledCommandContributions(extensionCommands, extensions))] : []
      const changed = await listen('desktop-keybindings-changed', () => { void publish().catch(() => {}) })
      if (disposed) { changed(); return }
      stops.push(changed)
      const triggered = await listen<{ bindingId: string; commandId: string; scope: 'focused' | 'global'; accountId: string }>('desktop-keybinding-trigger', ({ payload }) => {
        const state = useStore.getState()
        if (disposed || !account || payload.accountId !== state.user?.id || payload.accountId !== account) return
        const command = current.current.commands.find(cmd => cmd.id === payload.commandId)
        if (!command || !commandScopeActive(command.scope, current.current.path, state.isStreaming, state.messages.length)) return
        // Preserve modal interactions; a global Stop action can still stop generation.
        if (state.activeModal && command.id !== 'action-stop-generation') return
        const trigger: KeybindingTrigger = { type: 'keybind', bindingId: payload.bindingId, scope: payload.scope }
        void Promise.resolve().then(() => command.run(current.current.navigate, trigger)).catch(error => console.error('Desktop command failed', error))
      })
      if (disposed) { triggered(); return }
      stops.push(triggered)
      document.addEventListener('keydown', keydown, true)
      await publish()
    }
    void watch().catch(() => {}) // Older Desktop builds have no key binding commands.
    return () => {
      disposed = true
      document.removeEventListener('keydown', keydown, true)
      stops.forEach(stop => stop())
    }
  }, [account, role, extensionCommands, extensions, settingsTabs])

  useEffect(() => () => {
    if (!hasTauriDesktopBridge() || isDesktopFloatingWidgetWindow()) return
    // Clear authority on unmount, after any in-flight publication. Catalog updates
    // during extension reloads must not temporarily sign the frontend out.
    publishQueue.current = publishQueue.current.catch(() => {}).then(() => invoke('desktop_keybindings_publish', { accountId: '', commands: [] })).catch(() => {})
  }, [])
}
