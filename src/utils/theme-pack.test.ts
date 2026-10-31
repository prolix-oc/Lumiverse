import { expect, test } from 'bun:test';
import { createThemePack, decodeThemePackArchive, encodeThemePackArchive } from './theme-pack';

test('the shared archive codec preserves disabled CSS without secure-context UUID support', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const crypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
  try {
    const pack = createThemePack(null, { css: 'body{color:red}', enabled: false, revision: 0, bundleId: null }, {}, [], { name: 'Disabled' });
    const result = decodeThemePackArchive(encodeThemePackArchive(pack));
    expect(result.error).toBeUndefined();
    expect(result.pack?.bundleId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.pack?.globalCSSEnabled).toBe(false);
    expect(result.pack?.globalCSS).toBe('body{color:red}');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
