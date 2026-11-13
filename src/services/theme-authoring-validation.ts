import type { SpindleThemeDraft, SpindleThemeState as ThemeState } from 'lumiverse-spindle-types';
import type { CssNode, EnterOrLeaveFn } from 'css-tree';
import { generate, parse, walk, tokenize, tokenTypes, lexer } from 'css-tree';
import { serializeValueOrThrow } from './settings-validation';

const unescapeCSS = (value: string): string =>
  value.replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex: string, char: string) => {
    const code = hex ? parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : char;
  });

function parseStylesheet(css: string, warnings: string[]): CssNode {
  try {
    const stack: number[] = [];
    const open = new Map([
      [tokenTypes.LeftCurlyBracket, tokenTypes.RightCurlyBracket],
      [tokenTypes.LeftSquareBracket, tokenTypes.RightSquareBracket],
      [tokenTypes.LeftParenthesis, tokenTypes.RightParenthesis],
      [tokenTypes.Function, tokenTypes.RightParenthesis],
    ]);
    tokenize(css, (type, start, end) => {
      const expected = open.get(type);
      if (expected !== undefined) stack.push(expected);
      else if (
        [
          tokenTypes.RightCurlyBracket,
          tokenTypes.RightSquareBracket,
          tokenTypes.RightParenthesis,
        ].includes(type) &&
        stack.pop() !== type
      )
        throw new Error(`Unmatched CSS delimiter at character ${start + 1}`);
      if (type === tokenTypes.BadString || type === tokenTypes.BadUrl)
        throw new Error(`Invalid CSS token at character ${start + 1}`);
      if (type === tokenTypes.Comment && !css.slice(start, end).endsWith('*/'))
        throw new Error('Unclosed CSS comment');
      if (type === tokenTypes.String && css[start] !== css[end - 1])
        throw new Error('Unclosed CSS string');
    });
    if (stack.length) throw new Error('Unclosed CSS block or function');
    const ast = parse(css, {
      positions: true,
      parseCustomProperty: true,
      onParseError(error) {
        throw error;
      },
    });
    walk(ast, {
      visit: 'Declaration',
      enter(node) {
        if (
          this.atrule &&
          ['font-face', 'property', 'counter-style', 'font-palette-values'].includes(
            unescapeCSS(this.atrule.name).toLowerCase(),
          )
        )
          return;
        if (!node.property.startsWith('--') && !lexer.matchProperty(node.property, node.value).matched) {
          warnings.push(`Unsupported declaration: ${node.property}: ${generate(node.value)}`);
        }
      },
    });
    return ast;
  } catch (error) {
    throw new Error(`INVALID_THEME_CSS:${(error as Error).message}`);
  }
}

function sanitizeCSS(css: string, ast: CssNode): string {
  let changed = false;
  const sanitize: EnterOrLeaveFn = function (node, item, list) {
    if (node.type === 'Atrule' && unescapeCSS(node.name).toLowerCase() === 'import' && item && list) {
      list.remove(item);
      changed = true;
    } else if (
      node.type === 'Url' ||
      (node.type === 'String' &&
        this.function?.type === 'Function' &&
        /^(?:-webkit-)?image-set$/i.test(unescapeCSS(this.function.name)))
    ) {
      const url = unescapeCSS(node.value)
        .trim()
        .replaceAll('\\', '/')
        .replace(/[\u0000-\u0020]/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) && !/^data:/i.test(url)) {
        node.value = '';
        changed = true;
      }
    }
  };
  walk(ast, sanitize);
  return changed ? generate(ast) : css;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const MAX_CSS = 2_000_000;

function styles(css: string, warnings: string[]): string {
  if (typeof css !== 'string' || css.length > MAX_CSS)
    throw new Error('INVALID_THEME_CSS: stylesheet exceeds the size limit');
  const ast = parseStylesheet(css, warnings);
  const sanitized = sanitizeCSS(css, ast);
  if (sanitized !== css)
    warnings.push('External CSS imports or URLs were removed. Use bundled theme assets.');
  if (/:root[^{}]*\{[^}]*--(?:lumiverse|lcs)-/s.test(css) && !/!important/i.test(css))
    warnings.push(
      'Root variables without !important lose to generated inline theme variables. Prefer the theme configuration.',
    );
  return sanitized;
}

export const prepareThemeDraft = (
  draft: SpindleThemeDraft,
  state: ThemeState,
  mode: 'merge' | 'replace',
) => {
  if (!draft || typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 200)
    throw new Error('INVALID_THEME_DRAFT: name must contain 1 to 200 characters');
  for (const key of Object.keys(draft))
    if (
      ![
        'name',
        'author',
        'description',
        'theme',
        'globalCSS',
        'globalEnabled',
        'components',
        'assetBundleId',
      ].includes(key)
    )
      throw new Error(`INVALID_THEME_DRAFT: unknown field ${key}`);
  if (draft.author !== undefined && (typeof draft.author !== 'string' || draft.author.length > 200))
    throw new Error('INVALID_THEME_DRAFT: invalid author');
  if (
    draft.description !== undefined &&
    (typeof draft.description !== 'string' || draft.description.length > 5000)
  )
    throw new Error('INVALID_THEME_DRAFT: invalid description');
  if (draft.globalEnabled !== undefined && typeof draft.globalEnabled !== 'boolean')
    throw new Error('INVALID_THEME_DRAFT: globalEnabled must be boolean');
  if (
    draft.components !== undefined &&
    (!draft.components || typeof draft.components !== 'object' || Array.isArray(draft.components))
  )
    throw new Error('INVALID_THEME_DRAFT: components must be an object');
  if (draft.components !== undefined) serializeValueOrThrow('componentOverrides', draft.components);
  if (
    draft.assetBundleId !== undefined &&
    draft.assetBundleId !== null &&
    typeof draft.assetBundleId !== 'string'
  )
    throw new Error('INVALID_THEME_DRAFT: invalid asset bundle');
  const warnings: string[] = [];
  let theme = draft.theme === undefined ? state.theme : draft.theme === null ? null : draft.theme;
  if (draft.theme != null) {
    const config = draft.theme;
    const fields = [
      'id',
      'name',
      'mode',
      'accent',
      'radiusScale',
      'enableGlass',
      'fontScale',
      'uiScale',
      'liquidGlass',
      'characterAware',
      'baseColors',
      'baseColorsByMode',
      'statusColors',
      'desktopBackground',
      'renderingMode',
    ];
    if (Object.keys(config).some((key) => !fields.includes(key)))
      throw new Error('INVALID_THEME_DRAFT: unknown theme field');
    const bounded = (value: unknown, min: number, max: number) =>
      typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    if (
      !theme ||
      typeof config.id !== 'string' ||
      !config.id ||
      config.id.length > 200 ||
      typeof config.name !== 'string' ||
      !config.name ||
      config.name.length > 200 ||
      !['system', 'dark', 'light'].includes(config.mode) ||
      !bounded(config.accent?.h, 0, 360) ||
      !bounded(config.accent?.s, 0, 100) ||
      !bounded(config.accent?.l, 0, 100) ||
      !bounded(config.radiusScale, 0.5, 2) ||
      !bounded(config.fontScale, 0.85, 2) ||
      typeof config.enableGlass !== 'boolean' ||
      (config.uiScale !== undefined && !bounded(config.uiScale, 0.5, 1.5))
    )
      throw new Error('INVALID_THEME_DRAFT: provide a complete valid theme configuration');
    for (const value of [config.liquidGlass, config.characterAware])
      if (value !== undefined && typeof value !== 'boolean')
        throw new Error('INVALID_THEME_DRAFT: theme toggles must be boolean');
    if (
      config.renderingMode !== undefined &&
      !['efficiency', 'balanced', 'quality'].includes(config.renderingMode)
    )
      throw new Error('INVALID_THEME_DRAFT: invalid rendering mode');
    const desktop = config.desktopBackground;
    if (
      desktop !== undefined &&
      (!desktop ||
        typeof desktop !== 'object' ||
        Array.isArray(desktop) ||
        Object.keys(desktop).some((key) => !['color', 'blur', 'blurIntensity'].includes(key)) ||
        typeof desktop.color !== 'string' ||
        desktop.color.length > 200 ||
        !lexer.matchProperty('color', desktop.color).matched ||
        (desktop.blur !== undefined && typeof desktop.blur !== 'boolean') ||
        (desktop.blurIntensity !== undefined &&
          !['subtle', 'balanced', 'strong'].includes(desktop.blurIntensity)))
    )
      throw new Error('INVALID_THEME_DRAFT: invalid desktop background');
    if (
      config.baseColorsByMode !== undefined &&
      (!config.baseColorsByMode ||
        typeof config.baseColorsByMode !== 'object' ||
        Array.isArray(config.baseColorsByMode))
    )
      throw new Error('INVALID_THEME_DRAFT: invalid per-mode colors');
    for (const colors of [
      config.baseColors,
      config.baseColorsByMode?.dark,
      config.baseColorsByMode?.light,
      config.statusColors,
    ]) {
      if (
        colors !== undefined &&
        (!colors ||
          typeof colors !== 'object' ||
          Array.isArray(colors) ||
          Object.values(colors).some(
            (color) =>
              typeof color !== 'string' ||
              color.length > 200 ||
              !lexer.matchProperty('color', color).matched,
          ))
      )
        throw new Error('INVALID_THEME_DRAFT: invalid theme color');
    }
  }
  if (theme)
    theme = {
      ...clone(theme),
      desktopBackground: theme.desktopBackground ?? state.theme?.desktopBackground,
      renderingMode: theme.renderingMode ?? state.theme?.renderingMode,
    };
  const components = mode === 'merge' ? clone(state.components) : {};
  for (const [id, input] of Object.entries(draft.components ?? {})) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id) ||
      ['__proto__', 'constructor', 'prototype'].includes(id)
    )
      throw new Error('INVALID_THEME_COMPONENT_ID');
    if (input === null) {
      delete components[id];
      continue;
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((key) => !['css', 'enabled'].includes(key))
    )
      throw new Error('INVALID_THEME_DRAFT: component drafts accept CSS and enabled only');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      throw new Error('INVALID_THEME_DRAFT: enabled must be boolean');
    const existing = mode === 'merge' ? state.components[id] : undefined;
    if (existing?.tsx && !existing.enabled && input.enabled === true)
      throw new Error(
        'THEME_TSX_REVIEW_REQUIRED: enable quarantined component overrides in the native editor',
      );
    components[id] = {
      css: styles(input.css, warnings),
      tsx: existing?.tsx ?? '',
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
  }
  const globalCSS =
    draft.globalCSS === undefined
      ? mode === 'merge'
        ? state.customCSS.css
        : ''
      : styles(draft.globalCSS, warnings);
  const globalEnabled =
    draft.globalEnabled ??
    (draft.globalCSS === undefined && mode === 'merge' ? state.customCSS.enabled : !!globalCSS.trim());
  return { theme, components, globalCSS, globalEnabled, warnings: [...new Set(warnings)] };
};
