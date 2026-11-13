import { expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';

test('owner settings default to focused and register only after an explicit Save', async () => {
  const html = await Bun.file(new URL('../keybindings.html', import.meta.url)).text();
  const dom = new JSDOM(html, { url: 'http://localhost:1430/keybindings.html' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const saved: any[][] = [];
  let bindings: any[] = [];
  mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
  mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
    if (command === 'desktop_keybindings_save') { bindings = structuredClone(args.bindings); saved.push(bindings); return; }
    if (command === 'desktop_keybindings_get') return { bindings, commands: [], origin: '', accountId: '', errors: {}, globalAvailable: true };
    throw new Error(`Unexpected native command: ${command}`);
  } }));
  await import('../src/keybindings');
  await Bun.sleep(0);
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  expect(get<HTMLSelectElement>('scope').value).toBe('focused');
  expect(saved).toEqual([]);
  get<HTMLInputElement>('ctrl').checked = true;
  get<HTMLSelectElement>('key').value = 'KeyP';
  get('manual-chord').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  get('add-binding').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  expect(saved).toEqual([]);
  get('save').click();
  await Bun.sleep(0);
  expect(saved[0]).toHaveLength(1);
  expect(saved[0][0]).toMatchObject({ scope: 'focused', action: 'desktop:toggle-window', origin: null, accountId: null, chord: { code: 'KeyP', ctrl: true } });
  get<HTMLSelectElement>('scope').value = 'global';
  get<HTMLSelectElement>('key').value = 'KeyG';
  get('manual-chord').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  get('add-binding').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  get('save').click();
  await Bun.sleep(0);
  expect(saved[1][1].scope).toBe('global');
  expect(get('status').textContent).toBe('Bindings saved and active.');

  get<HTMLInputElement>('ctrl').checked = false;
  for (let number = 13; number <= 24; number++) {
    const code = `F${number}`;
    expect([...get<HTMLSelectElement>('key').options].some(option => option.value === code)).toBe(true);
    if (number === 13) {
      get('chord').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: code, code, bubbles: true, cancelable: true }));
    } else {
      get<HTMLSelectElement>('key').value = code;
      get('manual-chord').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
    get('add-binding').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    get('save').click();
    await Bun.sleep(0);
    expect(saved.at(-1)!.at(-1)).toMatchObject({ scope: 'global', chord: { code, ctrl: false, alt: false, shift: false, meta: false } });
  }
  get<HTMLSelectElement>('key').value = 'KeyP';
  get('manual-chord').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  get('add-binding').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  expect(get('status').textContent).toContain('Include Control');
  expect(document.querySelectorAll('#bindings p')).toHaveLength(14);
});
