import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './custom-url.css';
import './keybindings.css';

interface Chord { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
interface Binding { id: string; chord: Chord; scope: 'focused' | 'global'; action: string; origin: string | null; accountId: string | null }
interface Snapshot { bindings: Binding[]; commands: { id: string; label: string }[]; origin: string; accountId: string; errors: Record<string, string>; globalAvailable: boolean }
const nativeActions = [
  { id: 'desktop:toggle-window', label: 'Show / Hide Lumiverse' },
  { id: 'desktop:show-window', label: 'Show Lumiverse' },
  { id: 'desktop:reload', label: 'Reload Integrated Browser' },
  { id: 'desktop:stop-capture', label: 'Stop and Disable Extension Screen Capture' },
];
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status');
const action = element<HTMLSelectElement>('action');
const chordInput = element<HTMLInputElement>('chord');
const scope = element<HTMLSelectElement>('scope');
let chord: Chord | null = null;
let snapshot: Snapshot;
let bindings: Binding[] = [];
let dirty = false;
const format = (chord: Chord) => [chord.ctrl && 'Ctrl', chord.alt && 'Alt/Option', chord.shift && 'Shift', chord.meta && 'Cmd/Super', chord.code.replace(/^Key|^Digit/, '')].filter(Boolean).join(' + ');

function render() {
  const actions = [...nativeActions, ...snapshot.commands];
  const selected = action.value;
  action.replaceChildren(...actions.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option; }));
  if (actions.some(item => item.id === selected)) action.value = selected;
  element('availability').textContent = snapshot.globalAvailable
    ? 'Global shortcuts may conflict with shortcuts reserved by the OS or another app. Save reports conflicts.'
    : 'Global shortcuts are unavailable in this desktop session. App-focused bindings still work. Native Wayland sessions may require compositor shortcut support.';
  (scope.querySelector('option[value="global"]') as HTMLOptionElement).disabled = !snapshot.globalAvailable;
  element('bindings').replaceChildren(...bindings.map(binding => {
    const row = document.createElement('p');
    const label = actions.find(item => item.id === binding.action)?.label ?? binding.action;
    const unavailable = binding.origin && (binding.origin !== snapshot.origin || binding.accountId !== snapshot.accountId || !snapshot.commands.some(command => command.id === binding.action));
    const text = document.createElement('span');
    text.textContent = `${format(binding.chord)} · ${binding.scope === 'global' ? 'Global' : 'App focused'} · ${label}${unavailable ? ' (unavailable for the current account)' : ''}${snapshot.errors[binding.id] ? ` — ${snapshot.errors[binding.id]}` : ''} `;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-secondary'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${format(binding.chord)}`);
    remove.onclick = () => { bindings = bindings.filter(item => item.id !== binding.id); dirty = true; render(); };
    row.append(text, remove); return row;
  }));
}

chordInput.addEventListener('keydown', event => {
  event.preventDefault(); event.stopPropagation();
  if (event.repeat || event.isComposing || !event.code || /^(Control|Shift|Alt|Meta)/.test(event.code)) return;
  chord = { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
  chordInput.value = format(chord);
});
const key = element<HTMLSelectElement>('key');
for (const code of [...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`), ...Array.from({ length: 10 }, (_, i) => `Digit${i}`), ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), 'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
  const option = document.createElement('option'); option.value = code; option.textContent = code.replace(/^Key|^Digit/, ''); key.append(option);
}
element('manual-chord').addEventListener('change', () => {
  if (!key.value) return;
  chord = { code: key.value, ctrl: element<HTMLInputElement>('ctrl').checked, alt: element<HTMLInputElement>('alt').checked, shift: element<HTMLInputElement>('shift').checked, meta: element<HTMLInputElement>('meta').checked };
  chordInput.value = format(chord);
});
element('add-binding').addEventListener('submit', event => {
  event.preventDefault();
  if (!snapshot || !chord || !action.value) { status.textContent = 'Choose an action and press a shortcut first.'; return; }
  if (!(chord.ctrl || chord.alt || chord.meta || /^F(1[3-9]|2[0-4])$/.test(chord.code))) { status.textContent = 'Include Control, Alt/Option or Command/Super, or use F13–F24 on their own.'; return; }
  const native = nativeActions.some(item => item.id === action.value);
  bindings.push({ id: crypto.randomUUID(), chord: { ...chord }, scope: scope.value as Binding['scope'], action: action.value,
    origin: native ? null : snapshot.origin, accountId: native ? null : snapshot.accountId });
  dirty = true; render(); status.textContent = 'Added. Save to apply your bindings.';
});
element<HTMLButtonElement>('save').addEventListener('click', async () => {
  const save = element<HTMLButtonElement>('save'); save.disabled = true;
  try { await invoke('desktop_keybindings_save', { bindings }); dirty = false; await refresh(); status.textContent = 'Bindings saved and active.'; }
  catch (error) { status.textContent = String(error); }
  finally { save.disabled = false; }
});
async function refresh() {
  snapshot = await invoke<Snapshot>('desktop_keybindings_get');
  if (!dirty) bindings = snapshot.bindings;
  render();
}
void listen('desktop-keybindings-catalog', () => { void refresh().catch(error => { status.textContent = String(error); }); });
void refresh().catch(error => { status.textContent = String(error); });
