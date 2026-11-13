import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { env } from '../env';
import { loadThemeReferences, runThemeReferences } from './theme-reference.service';
import { createThemeReferencesRuntime } from '../spindle/theme-references-runtime';
import { handleThemeReferences } from '../spindle/theme-references-host';

test('references verify their build, share concurrent loads and expose only bundled keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'theme-references-'));
  const previous = env.frontendDir;
  env.frontendDir = directory;
  try {
    mkdirSync(join(directory, 'assets'));
    const reference = JSON.stringify({
      version: 'test',
      variables: { '--lumiverse-bg': '#111' },
      sources: { 'src/components/Test.tsx': 'export const Test = () => <div />' },
      docs: { 'themes.md': 'Theme guide' },
      components: [
        {
          component: 'Test',
          category: 'Test',
          rootSelector: '[data-component="Test"]',
          cssPath: 'src/components/Test.module.css',
          tsxPath: 'src/components/Test.tsx',
          renderSources: [],
          parts: [],
          classSelectors: { root: '._root_test' },
          template: '',
          props: [],
        },
      ],
    });
    const hash = createHash('sha256').update(reference).digest('hex');
    writeFileSync(join(directory, `assets/theme-reference.${hash}.json`), reference);
    const index = join(directory, 'assets/theme-reference-index.json');
    writeFileSync(index, JSON.stringify({ hash, asset: `assets/theme-reference.${hash}.json` }));
    const [first, second] = await Promise.all([loadThemeReferences(), loadThemeReferences()]);
    expect(first.bundle).toBe(second.bundle);
    const runtime = createThemeReferencesRuntime(message => new Promise((resolve, reject) => {
      void handleThemeReferences(message, response => response.error ? reject(new Error(response.error)) : resolve(response.result));
    }));
    const component = await runtime.request({ operation: 'component', args: { id: 'Test' } });
    expect(component.classSelectors.root).toBe('._root_test');
    expect(component.build.hash).toBe(hash);
    await expect(runThemeReferences('install', {})).rejects.toThrow('UNKNOWN_THEME_REFERENCE_OPERATION');
    await expect(runThemeReferences('read', { kind: 'source', path: 'src/components/Test.tsx', userId: 'other' })).rejects.toThrow('INVALID_THEME_REFERENCE_ARGUMENTS');
    for (const path of ['../env.ts', '__proto__'])
      await expect(runThemeReferences('read', { kind: 'source', path })).rejects.toThrow(
        'THEME_REFERENCE_NOT_FOUND',
      );
    const corrupt = '0'.repeat(64);
    writeFileSync(index, JSON.stringify({ hash: corrupt, asset: `assets/theme-reference.${corrupt}.json` }));
    writeFileSync(join(directory, `assets/theme-reference.${corrupt}.json`), reference);
    await expect(loadThemeReferences()).rejects.toThrow('THEME_REFERENCE_BUILD_MISMATCH');
  } finally {
    env.frontendDir = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
