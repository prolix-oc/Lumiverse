export interface DesktopChord { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
export interface DesktopBinding { id: string; chord: DesktopChord; scope: 'focused' | 'global' }
export interface ConfiguredDesktopBinding extends DesktopBinding { action: string; origin: string | null; accountId: string | null }
export interface DesktopKeybindingsSnapshot {
  bindings: ConfiguredDesktopBinding[]; commands: { id: string; label: string }[];
  origin: string; accountId: string; errors: Record<string, string>; globalAvailable: boolean; globalEnabled: boolean;
}
export const DESKTOP_KEYBINDING_ACTIONS = [
  { id: 'desktop:toggle-window', label: 'Show / Hide Lumiverse' },
  { id: 'desktop:show-window', label: 'Show Lumiverse' },
  { id: 'desktop:reload', label: 'Reload Integrated Browser' },
  { id: 'desktop:stop-capture', label: 'Stop and Disable Extension Screen Capture' },
]
export const DESKTOP_KEYBINDING_KEYS = [
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
]
/** Extended function keys can be used directly by keyboards and macro pads. */
export function isCompleteDesktopChord(chord: DesktopChord) {
  return DESKTOP_KEYBINDING_KEYS.includes(chord.code)
    && (chord.ctrl || chord.alt || chord.meta || /^F(1[3-9]|2[0-4])$/.test(chord.code))
}
export const formatDesktopChord = (chord: DesktopChord) => chord.code
  ? [chord.ctrl && 'Ctrl', chord.alt && 'Alt/Option', chord.shift && 'Shift', chord.meta && 'Cmd/Super', chord.code.replace(/^Key|^Digit/, '')].filter(Boolean).join(' + ') : ''
export interface KeybindingTrigger { type: 'keybind'; bindingId: string; scope: 'focused' | 'global' }

/** Global shortcuts are handled natively; a DOM event must never deliver them twice. */
export function matchingBinding(bindings: DesktopBinding[], event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>) {
  if (event.isComposing) return undefined;
  return bindings.find(binding => binding.chord.code === event.code
    && binding.chord.ctrl === event.ctrlKey && binding.chord.alt === event.altKey
    && binding.chord.shift === event.shiftKey && binding.chord.meta === event.metaKey);
}

export function commandScopeActive(scope: string | undefined, path: string, streaming: boolean, messages: number) {
  if (!scope || scope === 'global') return true;
  if (scope === 'chat') return path.startsWith('/chat/');
  if (scope === 'chat-idle') return path.startsWith('/chat/') && !streaming && messages > 0;
  if (scope === 'landing') return path === '/';
  if (scope === 'character') return path === '/characters' || /^\/characters\/[^/]+/.test(path);
  return false;
}
