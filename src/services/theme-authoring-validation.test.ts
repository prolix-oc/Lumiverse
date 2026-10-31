import { expect, test } from 'bun:test';
import { prepareThemeDraft } from './theme-authoring-validation';
import { DEFAULT_THEME } from '../utils/theme-config';
import type { SpindleThemeState } from 'lumiverse-spindle-types';

const state: SpindleThemeState = {
  revision: '',
  theme: null,
  defaultTheme: DEFAULT_THEME,
  customCSS: { css: '', enabled: false, revision: 0, bundleId: null },
  components: {},
  backups: [],
};

test.each([
  '@import "https://example.com/theme.css"; body{color:red}',
  '@\\69mport "https://example.com/theme.css"; body{color:red}',
  'body{background:url(https://example.com/image.png)}',
  'body{background:url(\\68 ttps://example.com/image.png)}',
  'body{background:url(//example.com/image.png)}',
  'body{background:image-set("https://example.com/image.png" 1x)}',
  'body{--image:url(https://example.com/image.png)}',
])('backend CSS sanitization removes external resources: %s', (css) => {
  const prepared = prepareThemeDraft({ name: 'External resource', globalCSS: css }, state, 'merge');
  expect(prepared.globalCSS).not.toContain('example.com');
  expect(prepared.warnings).toContain(
    'External CSS imports or URLs were removed. Use bundled theme assets.',
  );
});

test('backend CSS validation preserves local resources and rejects incomplete syntax', () => {
  const css = 'body{background:url(./assets/image.png),url(data:image/png;base64,AAEC)}';
  expect(prepareThemeDraft({ name: 'Local resources', globalCSS: css }, state, 'merge').globalCSS).toBe(css);
  expect(() => prepareThemeDraft({ name: 'Incomplete', globalCSS: 'body{' }, state, 'merge')).toThrow(
    'INVALID_THEME_CSS:Unclosed CSS block or function',
  );
});

test('aggregate component payloads must fit settings storage before CSS parsing', () => {
  const components = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`Component${index}`, { css: '{'.repeat(20000) }]),
  );
  expect(() => prepareThemeDraft({ name: 'Oversized', components }, state, 'merge')).toThrow(
    'Setting "componentOverrides" exceeds',
  );
});

test('bounded component drafts still validate and preserve omitted components', () => {
  const current = {
    ...state,
    components: { Existing: { css: '.root{color:red}', tsx: '', enabled: false } },
  };
  const prepared = prepareThemeDraft(
    { name: 'Valid', components: { New: { css: '.root{color:blue}' } } },
    current,
    'merge',
  );
  expect(prepared.components.Existing).toEqual(current.components.Existing);
  expect(prepared.components.New).toEqual({ css: '.root{color:blue}', tsx: '', enabled: true });
});
