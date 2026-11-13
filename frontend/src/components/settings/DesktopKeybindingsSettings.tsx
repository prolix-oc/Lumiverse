import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronRight, Globe2, Keyboard, Plus, Save, Trash2 } from 'lucide-react'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { Toggle } from '@/components/shared/Toggle'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '@/store'
import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { isDesktopFloatingWidgetWindow } from '@/lib/desktop-floating-widget'
import { DESKTOP_KEYBINDING_ACTIONS, DESKTOP_KEYBINDING_KEYS, formatDesktopChord, isCompleteDesktopChord, type ConfiguredDesktopBinding, type DesktopChord, type DesktopKeybindingsSnapshot } from '@/lib/desktop-keybindings'
import styles from './DesktopKeybindingsSettings.module.css'

const KEY_LABELS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'Page Up', PageDown: 'Page Down' }

export default function DesktopKeybindingsSettings({ extensionCommand }: { extensionCommand?: { extensionId: string; commandId: string } }) {
  const accountId = useStore(state => state.user?.id)
  const commandId = extensionCommand ? `ext-cmd-${extensionCommand.extensionId}-${extensionCommand.commandId}` : undefined
  const [snapshot, setSnapshot] = useState<DesktopKeybindingsSnapshot | null>(null)
  const [bindings, setBindings] = useState<ConfiguredDesktopBinding[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [recordingHint, setRecordingHint] = useState('')
  const dirtyRef = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const available = hasTauriDesktopBridge() && !isDesktopFloatingWidgetWindow()

  useEffect(() => {
    if (!available || !accountId) return
    let disposed = false
    const stops: Array<() => void> = []
    dirtyRef.current = false; setDirty(false); setSnapshot(null); setBindings([]); setStatus(''); setError('')
    let refreshRevision = 0
    const refresh = async () => {
      const revision = ++refreshRevision
      const next = await invoke<DesktopKeybindingsSnapshot>('desktop_keybindings_frontend_get')
      if (disposed || revision !== refreshRevision || next.accountId !== accountId) return
      setSnapshot(next); setError('')
      if (!dirtyRef.current) setBindings(next.bindings.filter(binding => !commandId || binding.action === commandId))
    }
    refreshRef.current = refresh
    const watch = async () => {
      for (const event of ['desktop-keybindings-catalog', 'desktop-keybindings-changed']) {
        const stop = await listen(event, () => { void refresh().catch(() => {}) })
        if (disposed) { stop(); return }
        stops.push(stop)
      }
      await refresh()
    }
    void watch().catch(() => { if (!disposed) setError('Could not load key bindings. Update Desktop and reopen Settings to try again.') })
    return () => {
      disposed = true; stops.forEach(stop => stop())
      void invoke('desktop_keybindings_editing', { editing: false }).catch(() => {})
    }
  }, [available, accountId, commandId])

  if (!available) return null
  const edit = (next: ConfiguredDesktopBinding[]) => {
    dirtyRef.current = true; setDirty(true); setBindings(next); setStatus(''); setError('')
  }
  const actions = [...DESKTOP_KEYBINDING_ACTIONS, ...(snapshot?.commands ?? [])].filter(action => !commandId || action.id === commandId)
  const update = (id: string, patch: Partial<ConfiguredDesktopBinding>) => edit(bindings.map(binding => binding.id === id ? { ...binding, ...patch } : binding))
  const setAction = (binding: ConfiguredDesktopBinding, action: string) => {
    const native = DESKTOP_KEYBINDING_ACTIONS.some(item => item.id === action)
    update(binding.id, { action, origin: native ? null : snapshot!.origin, accountId: native ? null : snapshot!.accountId })
  }
  const setChord = (binding: ConfiguredDesktopBinding, patch: Partial<DesktopChord>) => update(binding.id, { chord: { ...binding.chord, ...patch } })
  const enableGlobal = async (enabled: boolean) => {
    setBusy(true); setError(''); setStatus('')
    try {
      const granted = await invoke<boolean>('desktop_keybindings_global_permission', { accountId, enabled })
      if (useStore.getState().user?.id !== accountId) return
      if (enabled && !granted) { setStatus('Global key bindings remain off.'); return }
      if (!enabled) setBindings(current => current.map(binding => ({ ...binding, scope: 'focused' })))
      await refreshRef.current()
      setStatus(enabled ? 'Global key bindings enabled.' : 'Global key bindings disabled. Shortcuts now work only in Lumiverse.')
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setError(''); setStatus('')
    try {
      await invoke('desktop_keybindings_frontend_save', { accountId, bindings, commandId: commandId ?? null })
      if (useStore.getState().user?.id !== accountId) return
      dirtyRef.current = false; setDirty(false); await refreshRef.current(); setStatus('Key bindings saved.')
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const modifierLabels = ['Control', isMac ? 'Option' : 'Alt', 'Shift', isMac ? 'Command' : 'Super']
  const keyLabel = (code: string) => KEY_LABELS[code] ?? code.replace(/^Key|^Digit/, '')
  const chordLabels = (chord: DesktopChord) => [chord.ctrl && 'Ctrl', chord.alt && (isMac ? '⌥' : 'Alt'), chord.shift && (isMac ? '⇧' : 'Shift'), chord.meta && (isMac ? '⌘' : 'Super'), chord.code && keyLabel(chord.code)].filter(Boolean) as string[]
  const incomplete = bindings.some(binding => !isCompleteDesktopChord(binding.chord))
  const discard = () => {
    dirtyRef.current = false; setDirty(false)
    setBindings(snapshot!.bindings.filter(binding => !commandId || binding.action === commandId))
    setStatus(''); setError('')
  }

  return <div className={styles.container} data-desktop-keybinding-editor onFocusCapture={() => { void invoke('desktop_keybindings_editing', { editing: true }).catch(() => {}) }} onBlurCapture={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void invoke('desktop_keybindings_editing', { editing: false }).catch(() => {})
  }}>
    <header className={styles.header}>
      <Keyboard size={19} className={styles.headerIcon} aria-hidden="true" />
      <div>
        <h2 className={styles.title}>{commandId ? `Key Bindings: ${actions[0]?.label ?? extensionCommand.commandId}` : 'Key Bindings'}</h2>
        <p className={styles.description}>{commandId ? 'Shortcuts for this extension action.' : 'Quick access to desktop actions, app commands and extensions.'}</p>
      </div>
    </header>
    {!accountId && <p className={styles.hint}>Sign in to configure key bindings.</p>}
    {accountId && !snapshot && !error && <p className={styles.loading}>Loading key bindings…</p>}
    {snapshot && <>
      <section className={styles.section} aria-label="Global key bindings">
        <div className={styles.globalRow}>
          <div className={styles.globalText}>
            <h3 className={styles.sectionTitle}><Globe2 size={15} aria-hidden="true" />Global key bindings</h3>
            <p className={styles.hint}>{!snapshot.globalAvailable
              ? 'Unavailable in this desktop session. Shortcuts still work in Lumiverse.'
              : commandId && snapshot.globalEnabled ? 'Available for this action. Choose Global below to use it in other apps.'
              : 'Allow shortcuts while you use other apps. Requires desktop approval once.'}</p>
          </div>
          {commandId
            ? snapshot.globalEnabled ? <span className={styles.count}>Enabled</span> : <button className={styles.actionButton} type="button" disabled={busy || !snapshot.globalAvailable} onClick={() => void enableGlobal(true)}>Enable global key bindings</button>
            : <Toggle.Switch checked={snapshot.globalEnabled} disabled={busy || !snapshot.globalAvailable} onChange={enabled => void enableGlobal(enabled)} aria-label="Enable global key bindings" />}
        </div>
      </section>
      <section className={styles.section} aria-label="Shortcuts">
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}><Keyboard size={15} aria-hidden="true" />Shortcuts<span className={styles.count}>{bindings.length}</span></h3>
          <button className={styles.actionButton} type="button" disabled={busy || bindings.length >= 64 || !actions.length} onClick={() => edit([...bindings, { id: crypto.randomUUID(), action: actions[0].id, origin: commandId ? snapshot.origin : null, accountId: commandId ? snapshot.accountId : null, scope: 'focused', chord: { code: '', ctrl: false, alt: false, shift: false, meta: false } }])}><Plus size={13} aria-hidden="true" />Add Binding</button>
        </div>
        <fieldset className={styles.bindings} disabled={busy} aria-label="Configured shortcuts">
          {bindings.map((binding, index) => <div key={binding.id} className={styles.binding} role="group" aria-label={`Binding ${index + 1}`}>
            <div className={styles.bindingMain}>
              <div className={clsx(styles.field, styles.actionField)}>
                <span className={styles.fieldLabel}>Action</span>
                <SearchableSelect ariaLabel={`Action ${index + 1}`} value={binding.action} disabled={busy} onChange={action => setAction(binding, action)} searchPlaceholder="Find an action…" placeholder="Choose an action" options={[
                  ...(!actions.some(item => item.id === binding.action) ? [{ value: binding.action, label: binding.action, sublabel: 'Currently unavailable', group: 'Unavailable' }] : []),
                  ...actions.map(item => ({ value: item.id, label: item.label, group: item.id.startsWith('desktop:') ? 'Desktop' : item.id.startsWith('ext-cmd-') ? 'Extensions' : 'Application' })),
                ]} />
              </div>
              <div className={clsx(styles.field, styles.shortcutField)}>
                <span className={styles.fieldLabel}>Shortcut</span>
                <button type="button" className={styles.shortcut} aria-label={`Shortcut ${index + 1}`} aria-description={formatDesktopChord(binding.chord) || 'Not set'} title="Click and press a shortcut. Escape finishes recording." disabled={busy}
                  onClick={event => event.currentTarget.focus()}
                  onFocus={() => { setRecordingId(binding.id); setRecordingHint('') }}
                  onBlur={() => { setRecordingId(null); setRecordingHint('') }}
                  onKeyDown={event => {
                    if (event.key === 'Tab') return
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); return }
                    if (event.repeat || event.nativeEvent.isComposing || !DESKTOP_KEYBINDING_KEYS.includes(event.code)) return
                    event.preventDefault(); event.stopPropagation()
                    const nextChord = { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
                    if (!isCompleteDesktopChord(nextChord)) { setRecordingHint(`Include Control, ${isMac ? 'Option or Command' : 'Alt or Super'}, or use F13–F24 on their own.`); return }
                    setRecordingHint('')
                    setChord(binding, nextChord)
                  }}>
                  <span className={styles.keycaps}>{binding.chord.code ? chordLabels(binding.chord).map((label, key) => <kbd key={key} className={styles.keycap}>{label}</kbd>) : <span className={recordingId === binding.id ? styles.recording : styles.placeholder}>{recordingId === binding.id ? 'Press a shortcut…' : 'Click to record…'}</span>}</span>
                  <Keyboard size={13} aria-hidden="true" />
                </button>
              </div>
              <div className={clsx(styles.field, styles.scopeField)}>
                <span className={styles.fieldLabel}>Activation</span>
                <SearchableSelect ariaLabel={`Scope ${index + 1}`} value={binding.scope} disabled={busy} onChange={scope => update(binding.id, { scope: scope as ConfiguredDesktopBinding['scope'] })} options={[
                  { value: 'focused', label: 'In Lumiverse' },
                  { value: 'global', label: 'Global', disabled: !snapshot.globalEnabled || !snapshot.globalAvailable },
                ]} />
              </div>
              <button className={styles.remove} type="button" disabled={busy} onClick={() => edit(bindings.filter(item => item.id !== binding.id))} aria-label={`Remove binding ${index + 1}`} title="Remove binding"><Trash2 size={15} aria-hidden="true" /></button>
            </div>
            {recordingId === binding.id && <p className={clsx(styles.hint, styles.recording)}>{recordingHint || 'Press a shortcut to replace it. Tab moves on; Escape stops recording.'}</p>}
            <details className={styles.manual}><summary><ChevronRight size={12} aria-hidden="true" />Choose keys manually</summary><div className={styles.manualControls}>
              <div className={styles.modifiers}>{(['ctrl', 'alt', 'shift', 'meta'] as const).map((key, i) => <Toggle.Checkbox key={key} checked={binding.chord[key]} disabled={busy} onChange={checked => setChord(binding, { [key]: checked })} label={modifierLabels[i]} />)}</div>
              <SearchableSelect className={styles.manualKey} ariaLabel={`Key ${index + 1}`} value={binding.chord.code} disabled={busy} onChange={code => setChord(binding, { code })} placeholder="Choose a key…" searchPlaceholder="Find a key…" options={DESKTOP_KEYBINDING_KEYS.map(code => ({ value: code, label: keyLabel(code) }))} />
            </div></details>
            {snapshot.errors[binding.id] && <p className={styles.error} role="alert">{snapshot.errors[binding.id]}</p>}
          </div>)}
          {!bindings.length && <div className={styles.empty}><Keyboard size={24} aria-hidden="true" /><strong>No shortcuts yet</strong><span>{commandId ? 'Add a binding to run this action from your keyboard.' : 'Add a binding for an action you use often.'}</span></div>}
        </fieldset>
        <div className={styles.footer}>
          <span className={clsx(styles.saveState, dirty && styles.unsaved)}>{dirty ? incomplete ? 'Choose a shortcut for each action' : 'Unsaved changes' : 'Saved on this desktop'}</span>
          <div className={styles.footerActions}>
            {dirty && <button className={styles.actionButton} type="button" disabled={busy} onClick={discard}>Discard changes</button>}
            <button className={styles.saveButton} type="button" disabled={busy || !dirty || incomplete} onClick={() => void save()}><Save size={13} aria-hidden="true" />{busy ? 'Saving…' : 'Save Bindings'}</button>
          </div>
        </div>
      </section>
      <details className={styles.help}><summary>About shortcuts</summary>
        <p>F13–F24 work on their own or with modifiers. Other keys require Control, Alt/Option or Command/Super. In Lumiverse shortcuts work while the app is focused; Global shortcuts also work in other apps.</p>
        <p>App and extension shortcuts belong to this account and instance. Keep the integrated browser open and signed in. Commands follow their usual page and chat restrictions.</p>
      </details>
    </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.status} role="status" aria-live="polite">{status && <><Check size={14} aria-hidden="true" />{status}</>}</p>
  </div>
}
