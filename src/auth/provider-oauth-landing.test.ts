import { afterEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderProviderOAuthLanding } from './provider-oauth-landing';

const ORIGIN = 'https://lumiverse.example:8444';
const documents: JSDOM[] = [];
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });

function landing(options: Partial<Parameters<typeof renderProviderOAuthLanding>[0]> = {}) {
  const dom = new JSDOM(renderProviderOAuthLanding({
    provider: 'openrouter', code: 'valid-code', state: 'valid-state', openerOrigin: ORIGIN, ...options,
  }, (origin) => [ORIGIN, 'https://other.example'].includes(origin)), { url: `${ORIGIN}/api/v1/oauth-landing` });
  documents.push(dom);
  const timers: Array<() => void> = [];
  const run = new Function('window', 'document', 'setTimeout', dom.window.document.querySelector('script')!.textContent!);
  return {
    dom,
    timers,
    run: () => run(dom.window, dom.window.document, (callback: () => void) => { timers.push(callback); }),
  };
}

describe('provider OAuth landing', () => {
  test.each(['openrouter', 'nanogpt'] as const)('%s closes its native popup after publishing without an opener', async (provider) => {
    const page = landing({ provider });
    const invoke = mock(async () => {});
    Object.defineProperty(page.dom.window, '__TAURI_INTERNALS__', { value: { invoke } });
    page.run();
    expect(JSON.parse(page.dom.window.localStorage.getItem('lumiverse:provider-oauth:valid-state')!)).toEqual({
      type: `${provider}_oauth_code`, state: 'valid-state', code: 'valid-code',
    });
    expect(page.dom.window.document.getElementById('s')!.textContent).toBe('Authorized! Closing...');
    expect(invoke).not.toHaveBeenCalled();
    page.timers[0]();
    expect(invoke).toHaveBeenCalledWith('close_current_sso_popup');
  });

  test('falls back to browser close when native close is unavailable', async () => {
    const page = landing();
    const close = mock(() => {});
    page.dom.window.close = close;
    Object.defineProperty(page.dom.window, '__TAURI_INTERNALS__', {
      value: { invoke: async () => { throw new Error('Not permitted'); } },
    });
    page.run();
    page.timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('does not publish to local transports when the opener uses another allowed origin', () => {
    const page = landing({ openerOrigin: 'https://other.example' });
    const postMessage = mock(() => {});
    Object.defineProperty(page.dom.window, 'opener', { value: { postMessage } });
    const Channel = mock(() => {});
    Object.defineProperty(page.dom.window, 'BroadcastChannel', { value: Channel });
    page.run();
    expect(postMessage).toHaveBeenCalledWith({ type: 'openrouter_oauth_code', state: 'valid-state', code: 'valid-code' }, 'https://other.example');
    expect(Channel).not.toHaveBeenCalled();
    expect(page.dom.window.localStorage.length).toBe(0);
  });

  test('ignores an untrusted opener origin', () => {
    const page = landing({ openerOrigin: 'https://untrusted.example' });
    const postMessage = mock((_payload: unknown, _origin: string) => {});
    Object.defineProperty(page.dom.window, 'opener', { value: { postMessage } });
    page.run();
    expect(postMessage.mock.calls[0][1]).toBe(ORIGIN);
  });

  test.each([
    { code: '</script><script>alert(1)</script>' },
    { state: '"><script>alert(1)</script>' },
    { code: 'x'.repeat(513) },
    { state: '' },
  ])('does not publish malformed callbacks: %j', (options) => {
    const page = landing(options);
    const postMessage = mock(() => {});
    Object.defineProperty(page.dom.window, 'opener', { value: { postMessage } });
    page.run();
    expect(page.dom.window.document.querySelectorAll('script').length).toBe(1);
    expect(postMessage).not.toHaveBeenCalled();
    expect(page.dom.window.localStorage.length).toBe(0);
    expect(page.timers.length).toBe(0);
  });
});
