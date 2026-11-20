import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

// Execute the script shipped by Rust, including its real dismissal logic.
const source = await Bun.file(new URL('../src-tauri/src/frontend.rs', import.meta.url)).text();
const template = source.match(/r#"(\(\(\) => \{\{[\s\S]*?\}\}\)\(\);)"#/)![1];
const script = (snapshot: object) => template
  .replaceAll('{frontend_origin}', '"https://lumiverse.example:8444"')
  .replaceAll('{snapshot}', JSON.stringify(snapshot))
  .replaceAll('{windows_corners}', '')
  .replaceAll('{titlebar_height}', '36')
  .replaceAll('{corner_radius}', '12')
  .replaceAll('{{', '{').replaceAll('}}', '}');
const documents: JSDOM[] = [];
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });

function page(html: string, url = 'https://lumiverse.example:8444/', opener: unknown = null, windowLabel?: string, snapshot: object = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  documents.push(dom);
  Object.defineProperty(dom.window, 'opener', { value: opener });
  if (windowLabel) {
    Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
      value: { metadata: { currentWindow: { label: windowLabel } } },
    });
  }
  const timers = new Map<number, () => void>();
  dom.window.setTimeout = ((callback: () => void) => { timers.set(1, callback); return 1; }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id) => { timers.delete(id!); };
  dom.window.eval(script(snapshot));
  return { dom, timers, shell: () => dom.window.document.getElementById('lumiverse-startup-shell') };
}

describe('frontend startup readiness', () => {
  test.each(['/', '/login', '/sso-complete', '/stream-deck'])('dismisses as soon as React renders %s', async (path) => {
    const view = page('<div id="root"></div>', `https://lumiverse.example:8444${path}`);
    await Promise.resolve();
    expect(view.shell()).not.toBeNull();
    expect(view.timers.size).toBe(1);
    view.dom.window.document.getElementById('root')!.innerHTML = '<main>Ready</main>';
    await Promise.resolve();
    expect(view.shell()).toBeNull();
    expect(view.dom.window.document.documentElement.hasAttribute('data-lumiverse-startup-shell')).toBe(false);
    expect(view.timers.size).toBe(0);
  });

  test('dismisses parsed HTML without waiting for the failsafe', async () => {
    const view = page('<main>Authorized!</main>', 'https://lumiverse.example:8444/api/v1/openrouter/oauth-landing');
    expect(view.shell()).not.toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.shell()).toBeNull();
    expect(view.timers.size).toBe(0);
  });

  test.each([
    'https://openrouter.ai/auth',
    'https://nano-gpt.com/auth',
    'about:blank',
  ])('does not cover an inherited provider document at %s', (url) => {
    const view = page('<main>Sign in</main>', url);
    expect(view.shell()).toBeNull();
    expect(view.timers.size).toBe(0);
    expect(view.dom.window.document.documentElement.hasAttribute('data-tauri-desktop')).toBe(false);
  });

  test('does not add custom window chrome to a native popup on the app origin', () => {
    const view = page('<main>Authorized!</main>', 'https://lumiverse.example:8444/api/v1/nanogpt/oauth-landing', {});
    expect(view.shell()).toBeNull();
    expect(view.timers.size).toBe(0);
  });

  test('keeps main-window loading feedback when switching to another instance origin', async () => {
    const view = page('<div id="root"></div>', 'https://other-instance.example/', null, 'frontend');
    await Promise.resolve();
    expect(view.shell()).not.toBeNull();
    view.dom.window.document.getElementById('root')!.innerHTML = '<main>Ready</main>';
    await Promise.resolve();
    expect(view.shell()).toBeNull();
    expect(view.timers.size).toBe(0);
  });

  test('does not cover a native popup that has lost its opener', () => {
    const view = page('<main>Authorized!</main>', 'https://lumiverse.example:8444/api/v1/openrouter/oauth-landing', null, 'frontend-popup-1');
    expect(view.shell()).toBeNull();
    expect(view.timers.size).toBe(0);
  });
});


describe('native surface lifetime', () => {
  test('keeps the opaque canvas and mask-free app surface after React replaces the launch shell', async () => {
    const view = page('<div id="root"></div>', undefined, null, 'frontend', { surfaceMode: 'opaque', nativeColor: [61, 20, 32] });
    const doc = view.dom.window.document;
    expect(doc.documentElement.getAttribute('data-desktop-surface')).toBe('opaque');
    expect(doc.documentElement.style.getPropertyValue('--lumiverse-native-background')).toBe('rgb(61,20,32)');
    doc.getElementById('root')!.innerHTML = '<main data-app-root>Ready</main>';
    await Promise.resolve();
    expect(view.shell()).toBeNull();
    expect(doc.getElementById('lumiverse-native-surface')).not.toBeNull();
    expect(view.dom.window.getComputedStyle(doc.querySelector('main')!).clipPath).toBe('none');
  });

  test('does not install opaque overrides for a translucent window', async () => {
    const view = page('<div id="root"></div>', undefined, null, 'frontend', { surfaceMode: 'translucent' });
    expect(view.dom.window.document.documentElement.getAttribute('data-desktop-surface')).toBe('translucent');
    expect(view.dom.window.document.getElementById('lumiverse-native-surface')).toBeNull();
    view.dom.window.document.getElementById('root')!.innerHTML = '<main>Ready</main>';
    await Promise.resolve();
  });
});
