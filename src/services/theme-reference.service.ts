import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { env } from '../env';
import type { SpindleThemeComponentReference } from 'lumiverse-spindle-types';

const requestFields: Record<string, readonly string[]> = {
  components: ['query', 'offset', 'limit'],
  component: ['id'],
  variables: ['query'],
  search: ['query', 'kind', 'offset', 'limit'],
  read: ['kind', 'path', 'startLine', 'lineCount'],
};

export async function runThemeReferences(operation: string, args: unknown): Promise<unknown> {
  if (!Object.hasOwn(requestFields, operation)) throw new Error('UNKNOWN_THEME_REFERENCE_OPERATION');
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !requestFields[operation]!.includes(key))
  )
    throw new Error('INVALID_THEME_REFERENCE_ARGUMENTS');
  const { bundle, build } = await loadThemeReferences();
  return readThemeReference(bundle, build, operation, args as Record<string, unknown>);
}

export interface ThemeReferences {
  version: string;
  variables: Record<string, string>;
  sources: Record<string, string>;
  docs: Record<string, string>;
  components: Array<{
    component: string;
    category: string;
    rootSelector: string | null;
    cssPath: string;
    tsxPath: string | null;
    renderSources: string[];
    parts: string[];
    classSelectors: Record<string, string>;
    template: string;
    props: unknown[];
  }>;
}
const searchIndexes = new WeakMap<
  ThemeReferences,
  Array<{ kind: 'source' | 'doc'; path: string; text: string; lowerPath: string; lowerText: string }>
>();
const pending = new Map<string, Promise<{ root: string; hash: string; bundle: ThemeReferences }>>();
let cached: { root: string; hash: string; bundle: ThemeReferences } | undefined;

export async function loadThemeReferences() {
  const root = resolve(env.frontendDir || 'frontend/dist');
  const index = await Bun.file(resolve(root, 'assets/theme-reference-index.json'))
    .json()
    .catch(() => null);
  if (
    !index ||
    typeof index.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(index.hash) ||
    index.asset !== `assets/theme-reference.${index.hash}.json`
  ) {
    throw new Error('THEME_REFERENCES_UNAVAILABLE: build the frontend theme references.');
  }
  if (cached?.root !== root || cached.hash !== index.hash) {
    const key = `${root}:${index.hash}`;
    let loading = pending.get(key);
    if (!loading) {
      loading = (async () => {
        const bytes = await Bun.file(resolve(root, index.asset)).arrayBuffer();
        if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== index.hash)
          throw new Error('THEME_REFERENCE_BUILD_MISMATCH');
        return {
          root,
          hash: index.hash,
          bundle: JSON.parse(new TextDecoder().decode(bytes)) as ThemeReferences,
        };
      })();
      pending.set(key, loading);
      void loading
        .finally(() => {
          if (pending.get(key) === loading) pending.delete(key);
        })
        .catch(() => {});
    }
    cached = await loading;
  }
  return { bundle: cached.bundle, build: { version: cached.bundle.version, hash: cached.hash } };
}

function page<T>(items: T[], offset: unknown, limit: unknown) {
  const start = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
  return { total: items.length, items: items.slice(start, start + count) };
}

export function readThemeReference(
  bundle: ThemeReferences,
  build: { version: string; hash: string },
  operation: string,
  args: Record<string, unknown>,
): unknown {
  if (operation === 'components') {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    return page(
      bundle.components
        .filter((item) => `${item.component} ${item.category}`.toLowerCase().includes(query))
        .map((item) => ({ id: item.component, category: item.category, rootSelector: item.rootSelector })),
      args.offset,
      args.limit,
    );
  }
  if (operation === 'component') {
    const entry = bundle.components.find((item) => item.component === args.id);
    if (!entry) throw new Error('UNKNOWN_THEME_COMPONENT');
    return {
      id: entry.component,
      category: entry.category,
      rootSelector: entry.rootSelector,
      classSelectors: entry.classSelectors,
      parts: entry.parts,
      sources: [
        ...new Set(
          [entry.cssPath, entry.tsxPath, ...entry.renderSources].filter((path): path is string => !!path),
        ),
      ],
      template: entry.template,
      props: entry.props,
      build,
    } satisfies SpindleThemeComponentReference;
  }
  if (operation === 'variables') {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    return Object.entries(bundle.variables)
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, defaultValue]) => ({ name, defaultValue }));
  }
  if (operation === 'read') {
    const dictionary = args.kind === 'source' ? bundle.sources : args.kind === 'doc' ? bundle.docs : null;
    if (!dictionary || typeof args.path !== 'string' || !Object.hasOwn(dictionary, args.path))
      throw new Error('THEME_REFERENCE_NOT_FOUND');
    const lines = dictionary[args.path]!.split('\n');
    const start =
      typeof args.startLine === 'number' && Number.isFinite(args.startLine)
        ? Math.max(0, Math.floor(args.startLine) - 1)
        : 0;
    const count =
      typeof args.lineCount === 'number' && Number.isFinite(args.lineCount)
        ? Math.max(1, Math.min(300, Math.floor(args.lineCount)))
        : 120;
    const end = Math.min(lines.length, start + count);
    return {
      text: lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n'),
      totalLines: lines.length,
      startLine: start + 1,
      endLine: end,
      build,
    };
  }
  if (operation === 'search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000)
      throw new Error('INVALID_THEME_REFERENCE_QUERY');
    const query = args.query.toLowerCase();
    const matches: Array<{ kind: string; path: string; line: number; excerpt: string }> = [];
    let entries = searchIndexes.get(bundle);
    if (!entries) {
      entries = (['source', 'doc'] as const).flatMap((kind) =>
        Object.entries(kind === 'source' ? bundle.sources : bundle.docs).map(([path, text]) => ({
          kind,
          path,
          text,
          lowerPath: path.toLowerCase(),
          lowerText: text.toLowerCase(),
        })),
      );
      searchIndexes.set(bundle, entries);
    }
    for (const entry of entries) {
      if (args.kind !== undefined && args.kind !== entry.kind) continue;
      const index = entry.lowerText.indexOf(query);
      if (index < 0 && !entry.lowerPath.includes(query)) continue;
      const start = index < 0 ? 0 : entry.text.lastIndexOf('\n', index) + 1;
      const end = entry.text.indexOf('\n', start);
      matches.push({
        kind: entry.kind,
        path: entry.path,
        line: entry.text.slice(0, start).split('\n').length,
        excerpt: entry.text.slice(start, Math.min(start + 240, end < 0 ? entry.text.length : end)),
      });
    }
    return { ...page(matches, args.offset, args.limit), build };
  }
  throw new Error('UNKNOWN_THEME_REFERENCE_OPERATION');
}
