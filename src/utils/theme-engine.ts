/**
 * Server-side port of frontend/src/theme/engine.ts — generateThemeVariables().
 *
 * Pure computation: takes a theme config and resolved mode, returns the full
 * ~80+ CSS variable map.  Used by the Spindle theme API so extensions can
 * generate a coherent set of variables from an accent / base-color input
 * rather than guessing individual variable names.
 */

// ── Types ──

export interface ThemeVariablesInput {
  accent: { h: number; s: number; l: number };
  mode: "dark" | "light";
  enableGlass?: boolean;
  radiusScale?: number;
  fontScale?: number;
  uiScale?: number;
  baseColors?: {
    primary?: string;
    secondary?: string;
    background?: string;
    text?: string;
    danger?: string;
    success?: string;
    warning?: string;
    speech?: string;
    thoughts?: string;
  };
  statusColors?: {
    danger?: string;
    success?: string;
    warning?: string;
  };
}

// ── Color helpers ──

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function hsla(h: number, s: number, l: number, a: number = 1): string {
  return `hsla(${Math.round(h)}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%, ${a})`;
}

function rgba(r: number, g: number, b: number, a: number = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "");
  if (m.length === 3) {
    return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)];
  }
  if (m.length === 6) {
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  }
  return null;
}

function parseColorToRgb(color: string): [number, number, number] | null {
  if (color.startsWith("#")) return hexToRgb(color);
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
  const hslMatch = color.match(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/);
  if (hslMatch) {
    const hh = +hslMatch[1] / 360, ss = +hslMatch[2] / 100, ll = +hslMatch[3] / 100;
    if (ss === 0) { const v = Math.round(ll * 255); return [v, v, v]; }
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    return [
      Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, hh) * 255),
      Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
    ];
  }
  return null;
}

function ensureReadable(color: string, isDark: boolean): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;
  const [r, g, b] = rgb;
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
    else if (max === gN) h = ((bN - rN) / d + 2) / 6;
    else h = ((rN - gN) / d + 4) / 6;
  }
  const lPct = l * 100;
  const sPct = s * 100;
  const clampedL = isDark ? Math.max(lPct, 75) : Math.min(lPct, 35);
  const clampedS = Math.max(sPct, 30);
  if (Math.abs(clampedL - lPct) < 1 && Math.abs(clampedS - sPct) < 1) return color;
  return `hsl(${Math.round(h * 360)}, ${Math.round(clampedS)}%, ${Math.round(clampedL)}%)`;
}

/**
 * Clamp a surface color so it stays within eye-comfort ranges for the mode.
 * Dark mode: cap brightness so backgrounds never feel like light mode.
 * Light mode: floor brightness so backgrounds never feel like dark mode.
 */
function constrainSurface(color: string, isDark: boolean): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;
  const lum = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  if (isDark && lum > 80) {
    return adjustHex(color, -((lum - 80) / 175) * 0.5);
  }
  if (!isDark && lum < 200) {
    return adjustHex(color, ((200 - lum) / 200) * 0.35);
  }
  return color;
}

function contrastFor(color: string): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) return "#fff";
  const [r, g, b] = rgb;
  const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    const l = (max + min) / 2;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
    else if (max === gN) h = ((bN - rN) / d + 2) / 6;
    else h = ((rN - gN) / d + 4) / 6;
  }
  const isLight = lum > 140;
  const contrastL = isLight ? 15 : 95;
  const contrastS = Math.min(Math.round(s * 100), 30);
  return `hsl(${Math.round(h * 360)}, ${contrastS}%, ${contrastL}%)`;
}

function hexRgba(hex: string, a: number): string {
  const parsed = parseColorToRgb(hex);
  if (!parsed) return `rgba(128, 128, 128, ${a})`;
  return `rgba(${parsed[0]}, ${parsed[1]}, ${parsed[2]}, ${a})`;
}

function adjustHex(hex: string, factor: number): string {
  const parsed = parseColorToRgb(hex);
  if (!parsed) return hex;
  const adjust = (c: number) => Math.round(clamp(c + factor * 255, 0, 255));
  const r = adjust(parsed[0]);
  const g = adjust(parsed[1]);
  const b = adjust(parsed[2]);
  return `rgb(${r} ${g} ${b})`;
}

// ── Main generator ──

export function generateThemeVariables(input: ThemeVariablesInput): Record<string, string> {
  const { h, s, l } = input.accent;
  const isDark = input.mode === "dark";
  const rs = input.radiusScale ?? 1;
  const glass = input.enableGlass ?? true;
  const fs = input.fontScale ?? 1;

  const bgSat = s * 0.3;
  const textSat = s * 0.2;

  const vars: Record<string, string> = {};

  // ── Primary accent ──
  const pL = isDark ? Math.min(Math.max(l, 56), 75) : Math.min(Math.max(l - 20, 25), 45);
  vars["--lumiverse-primary"] = hsla(h, s, pL, 0.9);
  vars["--lumiverse-primary-hover"] = hsla(h, s, pL + 7, 0.95);
  vars["--lumiverse-primary-light"] = hsla(h, s, pL, 0.1);
  vars["--lumiverse-primary-muted"] = hsla(h, s, pL, 0.6);
  vars["--lumiverse-primary-text"] = hsla(h, s + 5, pL + 11, 0.95);
  vars["--lumiverse-primary-010"] = hsla(h, s, pL, 0.1);
  vars["--lumiverse-primary-015"] = hsla(h, s, pL, 0.15);
  vars["--lumiverse-primary-020"] = hsla(h, s, pL, 0.2);
  vars["--lumiverse-primary-050"] = hsla(h, s, pL, 0.5);
  vars["--lumiverse-primary-contrast"] = contrastFor(vars["--lumiverse-primary"]);

  // ── Secondary (neutral gray) ──
  vars["--lumiverse-secondary"] = rgba(128, 128, 128, 0.15);
  vars["--lumiverse-secondary-hover"] = rgba(128, 128, 128, 0.25);
  vars["--lumiverse-secondary-border"] = rgba(128, 128, 128, 0.25);

  // ── Status colors ──
  const danger = input.statusColors?.danger ?? "#ef4444";
  const success = input.statusColors?.success ?? "#22c55e";
  const warning = input.statusColors?.warning ?? "#f59e0b";
  vars["--lumiverse-danger"] = danger;
  vars["--lumiverse-danger-hover"] = "#dc2626";
  vars["--lumiverse-danger-015"] = rgba(239, 68, 68, 0.15);
  vars["--lumiverse-danger-020"] = rgba(239, 68, 68, 0.2);
  vars["--lumiverse-danger-050"] = rgba(239, 68, 68, 0.5);
  vars["--lumiverse-success"] = success;
  vars["--lumiverse-success-015"] = rgba(34, 197, 94, 0.15);
  vars["--lumiverse-success-020"] = rgba(34, 197, 94, 0.2);
  vars["--lumiverse-success-050"] = rgba(34, 197, 94, 0.5);
  vars["--lumiverse-warning"] = warning;
  vars["--lumiverse-warning-015"] = rgba(245, 158, 11, 0.15);
  vars["--lumiverse-warning-020"] = rgba(245, 158, 11, 0.2);
  vars["--lumiverse-warning-050"] = rgba(245, 158, 11, 0.5);
  vars["--lumiverse-error"] = vars["--lumiverse-danger"];

  // ── Backgrounds ──
  const bgA = isDark ? (glass ? 0.95 : 1) : 1;
  const bgElevA = isDark ? (glass ? 0.9 : 1) : 1;
  if (isDark) {
    vars["--lumiverse-bg"] = hsla(h, bgSat, 12, bgA);
    vars["--lumiverse-bg-elevated"] = hsla(h, bgSat, 15, bgElevA);
    vars["--lumiverse-bg-hover"] = hsla(h, bgSat, 19, bgElevA);
    vars["--lumiverse-bg-dark"] = rgba(0, 0, 0, 0.15);
    vars["--lumiverse-bg-darker"] = rgba(0, 0, 0, 0.25);
    vars["--lumiverse-bg-040"] = hsla(h, bgSat, 12, 0.4);
    vars["--lumiverse-bg-050"] = hsla(h, bgSat, 12, 0.5);
    vars["--lumiverse-bg-070"] = hsla(h, bgSat, 12, 0.7);
    vars["--lumiverse-bg-elevated-040"] = hsla(h, bgSat, 15, 0.4);
    vars["--lumiverse-bg-deep-080"] = hsla(h, bgSat, 9, 0.8);
    vars["--lumiverse-bg-deep"] = hsla(h, bgSat, 5, 1);
    vars["--lumiverse-scene-text-scrim"] = hsla(h, bgSat, 4, 0.48);
  } else {
    const lbgSat = s * 0.15;
    vars["--lumiverse-bg"] = hsla(h, lbgSat, 96, 1);
    vars["--lumiverse-bg-elevated"] = hsla(h, lbgSat, 100, 1);
    vars["--lumiverse-bg-hover"] = hsla(h, lbgSat, 93, 1);
    vars["--lumiverse-bg-dark"] = rgba(0, 0, 0, 0.04);
    vars["--lumiverse-bg-darker"] = rgba(0, 0, 0, 0.07);
    vars["--lumiverse-bg-040"] = hsla(h, lbgSat, 96, 0.4);
    vars["--lumiverse-bg-050"] = hsla(h, lbgSat, 96, 0.5);
    vars["--lumiverse-bg-070"] = hsla(h, lbgSat, 96, 0.7);
    vars["--lumiverse-bg-elevated-040"] = hsla(h, lbgSat, 100, 0.4);
    vars["--lumiverse-bg-deep-080"] = hsla(h, lbgSat, 92, 0.8);
    vars["--lumiverse-bg-deep"] = hsla(h, lbgSat, 90, 1);
    vars["--lumiverse-scene-text-scrim"] = hsla(h, lbgSat, 98, 0.56);
  }

  // ── Borders ──
  vars["--lumiverse-border"] = hsla(h, s, pL, isDark ? 0.12 : 0.15);
  vars["--lumiverse-border-hover"] = hsla(h, s, pL, isDark ? 0.25 : 0.3);
  vars["--lumiverse-border-light"] = rgba(128, 128, 128, isDark ? 0.12 : 0.15);
  vars["--lumiverse-border-neutral"] = rgba(128, 128, 128, isDark ? 0.15 : 0.18);
  vars["--lumiverse-border-neutral-hover"] = rgba(128, 128, 128, isDark ? 0.25 : 0.3);

  // ── Text ──
  if (isDark) {
    vars["--lumiverse-text"] = rgba(255, 255, 255, 0.9);
    vars["--lumiverse-text-muted"] = rgba(255, 255, 255, 0.65);
    vars["--lumiverse-text-dim"] = rgba(255, 255, 255, 0.4);
    vars["--lumiverse-text-hint"] = rgba(255, 255, 255, 0.3);
  } else {
    vars["--lumiverse-text"] = hsla(h, textSat, 10, 0.9);
    vars["--lumiverse-text-muted"] = hsla(h, textSat, 10, 0.6);
    vars["--lumiverse-text-dim"] = hsla(h, textSat, 10, 0.4);
    vars["--lumiverse-text-hint"] = hsla(h, textSat, 10, 0.3);
  }

  // ── Border radii ──
  const baseRadii = [5, 8, 10, 12, 16];
  const radiiNames = ["sm", "", "md", "lg", "xl"];
  radiiNames.forEach((name, i) => {
    const key = name ? `--lumiverse-radius-${name}` : "--lumiverse-radius";
    vars[key] = `${Math.round(baseRadii[i] * rs)}px`;
  });

  // ── Shadows ──
  const shadowAlpha = isDark ? 1 : 0.4;
  vars["--lumiverse-shadow"] = `0 4px 6px -1px ${rgba(0, 0, 0, 0.3 * shadowAlpha)}`;
  vars["--lumiverse-shadow-sm"] = `0 2px 8px ${rgba(0, 0, 0, 0.2 * shadowAlpha)}`;
  vars["--lumiverse-shadow-md"] = `0 8px 24px ${rgba(0, 0, 0, 0.4 * shadowAlpha)}`;
  vars["--lumiverse-shadow-lg"] = `0 24px 80px ${rgba(0, 0, 0, 0.5 * shadowAlpha)}, 0 0 1px ${hsla(h, s, pL, 0.3 * shadowAlpha)}`;
  vars["--lumiverse-shadow-xl"] = `0 20px 60px ${rgba(0, 0, 0, 0.5 * shadowAlpha)}`;

  // ── Highlight insets ──
  const hiAlpha = isDark ? 1 : 0.5;
  vars["--lumiverse-highlight-inset"] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.1 * hiAlpha)}`;
  vars["--lumiverse-highlight-inset-md"] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.2 * hiAlpha)}`;
  vars["--lumiverse-highlight-inset-lg"] = `inset 0 1px 0 ${rgba(255, 255, 255, 0.25 * hiAlpha)}`;

  // ── Modal & overlays ──
  vars["--lumiverse-modal-backdrop"] = rgba(0, 0, 0, isDark ? 0.6 : 0.3);
  vars["--lumiverse-swatch-border"] = rgba(255, 255, 255, isDark ? 0.15 : 0.3);
  if (isDark) {
    vars["--lumiverse-gradient-modal"] = `linear-gradient(135deg, ${hsla(h, bgSat, 15, 0.98)}, ${hsla(h, bgSat, 9, 0.98)})`;
  } else {
    vars["--lumiverse-gradient-modal"] = `linear-gradient(135deg, ${hsla(h, s * 0.15, 98, 0.98)}, ${hsla(h, s * 0.15, 95, 0.98)})`;
  }

  // ── Icon colors ──
  vars["--lumiverse-icon"] = vars["--lumiverse-text"];
  vars["--lumiverse-icon-muted"] = isDark ? rgba(255, 255, 255, 0.6) : hsla(h, textSat, 10, 0.55);
  vars["--lumiverse-icon-dim"] = vars["--lumiverse-text-dim"];

  // ── Fill colors ──
  const fillBase = isDark ? 1 : 0.4;
  vars["--lumiverse-fill-subtle"] = rgba(0, 0, 0, 0.1 * fillBase);
  vars["--lumiverse-fill"] = rgba(0, 0, 0, 0.15 * fillBase);
  vars["--lumiverse-fill-hover"] = rgba(0, 0, 0, 0.2 * fillBase);
  vars["--lumiverse-fill-medium"] = rgba(0, 0, 0, 0.25 * fillBase);
  vars["--lumiverse-fill-strong"] = rgba(0, 0, 0, 0.3 * fillBase);
  vars["--lumiverse-fill-heavy"] = rgba(0, 0, 0, 0.5 * fillBase);
  vars["--lumiverse-fill-deepest"] = rgba(0, 0, 0, 0.7 * fillBase);

  // ── Card backgrounds ──
  if (isDark) {
    vars["--lumiverse-card-bg"] = `linear-gradient(165deg, ${hsla(h, bgSat, 12, 1)} 0%, ${hsla(h, bgSat, 10, 1)} 50%, ${hsla(h, bgSat, 8, 1)} 100%)`;
    vars["--lumiverse-card-image-bg"] = `linear-gradient(135deg, ${hsla(h, bgSat, 9, 1)} 0%, ${hsla(h, bgSat, 13, 1)} 100%)`;
  } else {
    vars["--lumiverse-card-bg"] = `linear-gradient(165deg, ${hsla(h, s * 0.15, 99, 1)} 0%, ${hsla(h, s * 0.15, 97, 1)} 50%, ${hsla(h, s * 0.15, 95, 1)} 100%)`;
    vars["--lumiverse-card-image-bg"] = `linear-gradient(135deg, ${hsla(h, s * 0.15, 95, 1)} 0%, ${hsla(h, s * 0.15, 97, 1)} 100%)`;
  }

  // ── Transitions ──
  vars["--lumiverse-transition"] = "200ms ease";
  vars["--lumiverse-transition-fast"] = "150ms ease";

  // ── Typography ──
  vars["--lumiverse-font-family"] = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
  vars["--lumiverse-font-mono"] = '"SF Mono", "Menlo", "Monaco", "Consolas", monospace';
  vars["--lumiverse-font-scale"] = `${fs}`;

  const us = input.uiScale ?? 1;
  vars["--lumiverse-ui-scale"] = `${us}`;

  // ── Chat Shell glass tokens ──
  if (isDark) {
    vars["--lcs-glass-bg"] = glass ? hsla(h, bgSat, 6, 0.55) : hsla(h, bgSat, 10, 1);
    vars["--lcs-glass-bg-hover"] = glass ? hsla(h, bgSat, 9, 0.65) : hsla(h, bgSat, 14, 1);
    vars["--lcs-glass-border"] = rgba(255, 255, 255, glass ? 0.06 : 0.05);
    vars["--lcs-glass-border-hover"] = rgba(255, 255, 255, glass ? 0.1 : 0.08);
    vars["--lcs-glass-blur"] = glass ? "8px" : "0px";
    vars["--lcs-glass-soft-blur"] = glass ? "6px" : "0px";
    vars["--lcs-glass-strong-blur"] = glass ? "12px" : "0px";
  } else {
    vars["--lcs-glass-bg"] = glass ? hsla(h, s * 0.15, 98, 0.6) : hsla(h, s * 0.15, 97, 1);
    vars["--lcs-glass-bg-hover"] = glass ? hsla(h, s * 0.15, 100, 0.72) : hsla(h, s * 0.15, 99, 1);
    vars["--lcs-glass-border"] = rgba(0, 0, 0, glass ? 0.06 : 0.09);
    vars["--lcs-glass-border-hover"] = rgba(0, 0, 0, glass ? 0.08 : 0.12);
    vars["--lcs-glass-blur"] = glass ? "8px" : "0px";
    vars["--lcs-glass-soft-blur"] = glass ? "6px" : "0px";
    vars["--lcs-glass-strong-blur"] = glass ? "12px" : "0px";
  }
  vars["--lcs-radius"] = `${Math.round(14 * rs)}px`;
  vars["--lcs-radius-sm"] = `${Math.round(8 * rs)}px`;
  vars["--lcs-radius-xs"] = `${Math.round(5 * rs)}px`;
  vars["--lcs-transition"] = "220ms cubic-bezier(0.4, 0, 0.2, 1)";
  vars["--lcs-transition-fast"] = "120ms cubic-bezier(0.4, 0, 0.2, 1)";

  // ── Prose tokens ──
  vars["--lumiverse-prose-italic"] = "var(--lumiverse-text-muted)";
  vars["--lumiverse-prose-bold"] = "inherit";
  vars["--lumiverse-prose-dialogue"] = "var(--lumiverse-primary-text)";
  vars["--lumiverse-prose-blockquote"] = "var(--lumiverse-text-muted)";
  vars["--lumiverse-prose-link"] = hsla(h, s + 10, pL + 15, 0.9);

  // ── Base color overrides ──
  const bc = input.baseColors;
  if (bc) {
    if (bc.primary) {
      const primary = ensureReadable(bc.primary, isDark);
      vars["--lumiverse-primary"] = primary;
      vars["--lumiverse-primary-hover"] = adjustHex(primary, isDark ? 0.08 : -0.06);
      vars["--lumiverse-primary-light"] = hexRgba(primary, 0.1);
      vars["--lumiverse-primary-muted"] = hexRgba(primary, 0.6);
      vars["--lumiverse-primary-text"] = adjustHex(primary, isDark ? 0.1 : -0.08);
      vars["--lumiverse-primary-010"] = hexRgba(primary, 0.1);
      vars["--lumiverse-primary-015"] = hexRgba(primary, 0.15);
      vars["--lumiverse-primary-020"] = hexRgba(primary, 0.2);
      vars["--lumiverse-primary-050"] = hexRgba(primary, 0.5);
      vars["--lumiverse-primary-contrast"] = contrastFor(primary);
      vars["--lumiverse-prose-dialogue"] = ensureReadable(adjustHex(primary, isDark ? 0.1 : -0.08), isDark);
    }
    if (bc.secondary) {
      vars["--lumiverse-secondary"] = hexRgba(bc.secondary, 0.15);
      vars["--lumiverse-secondary-hover"] = hexRgba(bc.secondary, 0.25);
      vars["--lumiverse-secondary-border"] = hexRgba(bc.secondary, 0.25);
    }
    if (bc.background) {
      const bg = constrainSurface(bc.background, isDark);
      vars["--lumiverse-bg"] = bg;
      vars["--lumiverse-bg-elevated"] = adjustHex(bg, 0.04);
      vars["--lumiverse-bg-hover"] = adjustHex(bg, 0.06);
      vars["--lumiverse-bg-deep"] = adjustHex(bg, -0.05);
    }
    if (bc.text) {
      const text = ensureReadable(bc.text, isDark);
      vars["--lumiverse-text"] = text;
      vars["--lumiverse-text-muted"] = hexRgba(text, 0.65);
      vars["--lumiverse-text-dim"] = hexRgba(text, 0.4);
      vars["--lumiverse-text-hint"] = hexRgba(text, 0.3);
    }
    if (bc.danger) {
      const danger = ensureReadable(bc.danger, isDark);
      vars["--lumiverse-danger"] = danger;
      vars["--lumiverse-danger-hover"] = adjustHex(danger, -0.06);
      vars["--lumiverse-danger-015"] = hexRgba(danger, 0.15);
      vars["--lumiverse-danger-020"] = hexRgba(danger, 0.2);
      vars["--lumiverse-danger-050"] = hexRgba(danger, 0.5);
    }
    if (bc.success) {
      const success = ensureReadable(bc.success, isDark);
      vars["--lumiverse-success"] = success;
      vars["--lumiverse-success-015"] = hexRgba(success, 0.15);
      vars["--lumiverse-success-020"] = hexRgba(success, 0.2);
      vars["--lumiverse-success-050"] = hexRgba(success, 0.5);
    }
    if (bc.warning) {
      const warning = ensureReadable(bc.warning, isDark);
      vars["--lumiverse-warning"] = warning;
      vars["--lumiverse-warning-015"] = hexRgba(warning, 0.15);
      vars["--lumiverse-warning-020"] = hexRgba(warning, 0.2);
      vars["--lumiverse-warning-050"] = hexRgba(warning, 0.5);
    }
    if (bc.speech) {
      vars["--lumiverse-prose-dialogue"] = ensureReadable(bc.speech, isDark);
    }
    if (bc.thoughts) {
      vars["--lumiverse-prose-italic"] = ensureReadable(bc.thoughts, isDark);
    }
  }

  return vars;
}
