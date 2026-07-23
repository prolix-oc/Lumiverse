type Rgba = { r: number; g: number; b: number; a: number }

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function parseHexColor(color: string): Rgba | null {
  const hex = color.slice(1)
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1,
    }
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: parseInt(hex[3] + hex[3], 16) / 255,
    }
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    }
  }
  return null
}

function hslToRgba(h: number, s: number, l: number, a = 1): Rgba {
  const hh = ((h % 360) + 360) % 360 / 360
  const ss = clamp(s, 0, 100) / 100
  const ll = clamp(l, 0, 100) / 100
  if (ss === 0) {
    const v = Math.round(ll * 255)
    return { r: v, g: v, b: v, a }
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }

  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  return {
    r: Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hh) * 255),
    b: Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
    a,
  }
}

function parseRgbComponent(value: string): number {
  const numeric = Number(value.slice(0, value.endsWith('%') ? -1 : undefined))
  return clamp(value.endsWith('%') ? numeric * 2.55 : numeric, 0, 255)
}

function parseAlphaComponent(value: string): number {
  const numeric = Number(value.slice(0, value.endsWith('%') ? -1 : undefined))
  return clamp(value.endsWith('%') ? numeric / 100 : numeric, 0, 1)
}

function parseThemeColor(token: string): Rgba | null {
  if (token.startsWith('#')) return parseHexColor(token)

  const component = '(-?(?:\\d*\\.\\d+|\\d+\\.?\\d*)%?)'
  const rgbMatch = token.match(new RegExp(
    `^rgba?\\(\\s*${component}\\s*(?:,\\s*|\\s+)${component}\\s*(?:,\\s*|\\s+)${component}(?:\\s*(?:,\\s*|/\\s*)${component})?\\s*\\)$`,
    'i',
  ))
  if (rgbMatch) {
    return {
      r: parseRgbComponent(rgbMatch[1]),
      g: parseRgbComponent(rgbMatch[2]),
      b: parseRgbComponent(rgbMatch[3]),
      a: rgbMatch[4] === undefined ? 1 : parseAlphaComponent(rgbMatch[4]),
    }
  }

  const hslMatch = token.match(/hsla?\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)%\s*,\s*(-?\d*\.?\d+)%(?:\s*,\s*(-?\d*\.?\d+))?\s*\)/i)
  if (hslMatch) {
    return hslToRgba(
      Number(hslMatch[1]),
      Number(hslMatch[2]),
      Number(hslMatch[3]),
      hslMatch[4] === undefined ? 1 : clamp(Number(hslMatch[4]), 0, 1),
    )
  }

  return null
}

/** Convert a CSS RGB(A) value to the opaque color needed by native PWA chrome. */
export function toOpaqueRgbChannels(color: string): [number, number, number] | null {
  const parsed = parseThemeColor(color)
  if (!parsed) return null

  // Native window chrome expects an opaque color. Composite translucent theme
  // tokens against black, matching the app's deep shell background.
  const mix = (channel: number) => Math.round(channel * parsed.a)
  return [mix(parsed.r), mix(parsed.g), mix(parsed.b)]
}

/** Convert a CSS RGB(A) value to the opaque color needed by native PWA chrome. */
export function toOpaqueRgb(color: string): string | null {
  const channels = toOpaqueRgbChannels(color)
  return channels ? `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})` : null
}
