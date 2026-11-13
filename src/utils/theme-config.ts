import type { SpindleThemeConfiguration as ThemeConfig } from 'lumiverse-spindle-types';

export const DEFAULT_THEME: ThemeConfig = {
  id: 'lumiverse-purple',
  name: 'Lumiverse Purple',
  mode: 'dark',
  accent: { h: 263, s: 55, l: 65 },
  radiusScale: 1,
  enableGlass: true,
  fontScale: 1,
};

// Older saved themes may omit fields that the renderer requires.
export function normalizeTheme(input: unknown): ThemeConfig | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null;
  const t = input as Partial<ThemeConfig>;
  const a = t.accent as { h?: unknown; s?: unknown; l?: unknown } | undefined;
  const accentValid =
    !!a && typeof a.h === 'number' && typeof a.s === 'number' && typeof a.l === 'number';
  const desktopBackground = t.desktopBackground;
  const blurIntensity = desktopBackground?.blurIntensity;
  const renderingMode = t.renderingMode;

  return {
    ...DEFAULT_THEME,
    ...t,
    accent: accentValid ? (t.accent as ThemeConfig['accent']) : DEFAULT_THEME.accent,
    radiusScale: typeof t.radiusScale === 'number' ? t.radiusScale : DEFAULT_THEME.radiusScale,
    enableGlass: typeof t.enableGlass === 'boolean' ? t.enableGlass : DEFAULT_THEME.enableGlass,
    liquidGlass: typeof t.liquidGlass === 'boolean' ? t.liquidGlass : DEFAULT_THEME.liquidGlass,
    fontScale: typeof t.fontScale === 'number' ? t.fontScale : DEFAULT_THEME.fontScale,
    renderingMode:
      renderingMode === 'efficiency' || renderingMode === 'quality' || renderingMode === 'balanced'
        ? renderingMode
        : 'balanced',
    desktopBackground:
      desktopBackground && typeof desktopBackground.color === 'string'
        ? {
            color: desktopBackground.color,
            ...(typeof desktopBackground.blur === 'boolean' ? { blur: desktopBackground.blur } : {}),
            ...(blurIntensity === 'subtle' || blurIntensity === 'balanced' || blurIntensity === 'strong'
              ? { blurIntensity }
              : {}),
          }
        : undefined,
  };
}
