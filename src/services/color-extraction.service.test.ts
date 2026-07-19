import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  extractColorsFromRawPixels,
  rgbToHsl,
  type RGB,
} from "./color-extraction.service";

function makeImage(width: number, height: number, fill: (x: number, y: number) => RGB): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const color = fill(x, y);
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function distance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function luminance(color: RGB): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

describe("extractColorsFromRawPixels", () => {
  test("keeps near-identical dominant shades from crowding out more distinct accents", () => {
    const blueA = { r: 64, g: 102, b: 214 };
    const blueB = { r: 74, g: 112, b: 224 };
    const orange = { r: 236, g: 132, b: 58 };
    const green = { r: 62, g: 190, b: 118 };

    const data = makeImage(12, 12, (x, y) => {
      if (x < 7) return (x + y) % 2 === 0 ? blueA : blueB;
      if (y < 4) return orange;
      if (y >= 8) return green;
      return blueB;
    });

    const result = extractColorsFromRawPixels(data, 12, 12, 4);
    const blueLikeCount = result.palette.filter((color) => distance(color, blueA) < 28 || distance(color, blueB) < 28).length;

    expect(result.diversity.isUniform).toBe(false);
    expect(blueLikeCount).toBe(1);
    expect(result.palette.some((color) => distance(color, orange) < 24)).toBe(true);
    expect(result.palette.some((color) => distance(color, green) < 24)).toBe(true);
  });

  test("falls back to a synthetic readable palette for uniform imagery", () => {
    const grey = { r: 138, g: 138, b: 138 };
    const data = makeImage(12, 12, () => grey);
    const result = extractColorsFromRawPixels(data, 12, 12, 4);

    expect(result.diversity.isUniform).toBe(true);
    expect(result.diversity.usedFallback).toBe(true);
    expect(result.palette).toHaveLength(5);
  });

  test("derives readable text and button colors for both UI surfaces", () => {
    const data = makeImage(12, 12, (x, y) => {
      if (x < 4) return { r: 38, g: 44, b: 92 };
      if (x < 8) return { r: 118, g: 74, b: 180 };
      return y < 6 ? { r: 228, g: 146, b: 84 } : { r: 72, g: 168, b: 120 };
    });

    const result = extractColorsFromRawPixels(data, 12, 12, 4);

    expect(contrastRatio(result.ui.dark.text, result.ui.dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.ui.dark.accentText, result.ui.dark.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.ui.dark.accent, result.ui.dark.surface)).toBeGreaterThanOrEqual(3);

    expect(contrastRatio(result.ui.light.text, result.ui.light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.ui.light.accentText, result.ui.light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.ui.light.accent, result.ui.light.surface)).toBeGreaterThanOrEqual(3);
  });

  test("keeps dark-mode surfaces dark even when the image is mostly pale", () => {
    const pale = { r: 235, g: 224, b: 210 };
    const deepBlue = { r: 38, g: 52, b: 104 };
    const berry = { r: 156, g: 68, b: 112 };

    const data = makeImage(16, 16, (x, y) => {
      if (x < 3) return deepBlue;
      if (y > 10 && x > 9) return berry;
      return pale;
    });

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    expect(luminance(result.ui.dark.surface)).toBeLessThan(70);
    expect(luminance(result.ui.dark.surface)).toBeGreaterThanOrEqual(24);
    expect(luminance(result.ui.light.surface)).toBeGreaterThan(210);
    expect(luminance(result.ui.dark.surface)).toBeLessThan(luminance(result.ui.light.surface));
  });

  test("lifts mostly black images into readable dark-mode theme ranges", () => {
    const black = { r: 2, g: 3, b: 6 };
    const indigo = { r: 24, g: 30, b: 92 };
    const violet = { r: 92, g: 54, b: 160 };

    const data = makeImage(16, 16, (x, y) => {
      if (x > 12 && y < 4) return violet;
      if (x > 10) return indigo;
      return black;
    });

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    expect(luminance(result.ui.dark.surface)).toBeGreaterThanOrEqual(24);
    expect(luminance(result.ui.dark.surface)).toBeLessThanOrEqual(68);
    expect(luminance(result.ui.dark.accent)).toBeGreaterThanOrEqual(118);
    expect(contrastRatio(result.ui.dark.accent, result.ui.dark.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(result.ui.dark.text, result.ui.dark.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps mostly white images below glare range for light-mode themes", () => {
    const white = { r: 253, g: 253, b: 250 };
    const gold = { r: 238, g: 178, b: 72 };
    const rose = { r: 204, g: 92, b: 126 };

    const data = makeImage(16, 16, (x, y) => {
      if (x < 3 && y > 10) return rose;
      if (y < 3) return gold;
      return white;
    });

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    expect(luminance(result.ui.light.surface)).toBeGreaterThanOrEqual(218);
    expect(luminance(result.ui.light.surface)).toBeLessThanOrEqual(246);
    expect(luminance(result.ui.light.accent)).toBeGreaterThanOrEqual(54);
    expect(luminance(result.ui.light.accent)).toBeLessThanOrEqual(154);
    expect(contrastRatio(result.ui.light.accent, result.ui.light.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(result.ui.light.text, result.ui.light.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("preserves perceptually distinct hues instead of collapsing into a single mid-tone family", () => {
    const red = { r: 210, g: 60, b: 60 };
    const green = { r: 60, g: 180, b: 80 };
    const blue = { r: 60, g: 80, b: 210 };
    const gold = { r: 230, g: 180, b: 50 };

    const data = makeImage(16, 16, (x, y) => {
      if (x < 8 && y < 8) return red;
      if (x >= 8 && y < 8) return green;
      if (x < 8 && y >= 8) return blue;
      return gold;
    });

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    // The palette should contain a member of each distinct hue family.
    const hasRedLike = result.palette.some((c) => c.r > c.g && c.r > c.b && c.r > 120);
    const hasGreenLike = result.palette.some((c) => c.g > c.r && c.g > c.b && c.g > 120);
    const hasBlueLike = result.palette.some((c) => c.b > c.r && c.b > c.g && c.b > 120);
    const hasGoldLike = result.palette.some((c) => c.r > c.b && c.g > c.b && c.r > 160);

    expect(result.diversity.isUniform).toBe(false);
    expect(hasRedLike || hasGoldLike).toBe(true);
    expect(hasGreenLike).toBe(true);
    expect(hasBlueLike).toBe(true);
  });

  test("classifies Vibrant and Muted swatches from a colorful image", () => {
    const red = { r: 220, g: 60, b: 60 };
    const grey = { r: 140, g: 140, b: 140 };

    const data = makeImage(16, 16, (x) => (x < 8 ? red : grey));

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    expect(result.swatches.vibrant).not.toBeNull();
    expect(result.swatches.muted).not.toBeNull();
  });

  test("produces an ambient gradient and character overlay", () => {
    const red = { r: 210, g: 60, b: 60 };
    const green = { r: 60, g: 180, b: 80 };

    const data = makeImage(12, 12, (x) => (x < 6 ? red : green));

    const result = extractColorsFromRawPixels(data, 12, 12, 4);

    expect(result.ambient.dark).toBeDefined();
    expect(result.ambient.light).toBeDefined();
    expect(result.overlay.accent).toBeDefined();
    expect(result.overlay.baseColors.primary).toMatch(/^rgb\(/);
    expect(result.overlay.baseColorsLight.primary).toMatch(/^rgb\(/);
  });

  test("anchors dark and light accents to the same vibrant hue family", () => {
    const gold = { r: 230, g: 180, b: 50 };
    const blue = { r: 50, g: 70, b: 200 };

    const data = makeImage(16, 16, (x) => (x < 8 ? gold : blue));

    const result = extractColorsFromRawPixels(data, 16, 16, 4);

    // Both accents should be roughly the same hue (within ~30 degrees) so the
    // UI doesn't feel like a completely different theme when toggling modes.
    const darkHue = rgbToHsl(result.ui.dark.accent.r, result.ui.dark.accent.g, result.ui.dark.accent.b).h;
    const lightHue = rgbToHsl(result.ui.light.accent.r, result.ui.light.accent.g, result.ui.light.accent.b).h;
    const hueDiff = Math.abs(darkHue - lightHue);
    expect(Math.min(hueDiff, 360 - hueDiff)).toBeLessThanOrEqual(45);
  });

  test("anchors pastel surfaces to the image's hue family instead of fixed gray", () => {
    const pink = { r: 255, g: 182, b: 193 };
    const lavender = { r: 216, g: 191, b: 216 };
    const paleBlue = { r: 230, g: 230, b: 250 };

    const data = makeImage(16, 16, (x, y) => {
      if (y < 4) return pink;
      if (y < 8) return lavender;
      if (y < 12) return paleBlue;
      return { r: 245, g: 245, b: 220 };
    });

    const result = extractColorsFromRawPixels(data, 16, 16, 4);
    const dominantHue = rgbToHsl(result.dominant.r, result.dominant.g, result.dominant.b).h;
    const darkSurfaceHue = rgbToHsl(result.ui.dark.surface.r, result.ui.dark.surface.g, result.ui.dark.surface.b).h;
    const darkAccentHue = rgbToHsl(result.ui.dark.accent.r, result.ui.dark.accent.g, result.ui.dark.accent.b).h;

    // Surface should sit in the same hue family as the dominant image color
    // (pink/red), not drift to the old fixed blue-gray.
    const surfaceHueDiff = Math.abs(darkSurfaceHue - dominantHue);
    expect(Math.min(surfaceHueDiff, 360 - surfaceHueDiff)).toBeLessThanOrEqual(60);

    // Accent should be even closer to the dominant hue family.
    const accentHueDiff = Math.abs(darkAccentHue - dominantHue);
    expect(Math.min(accentHueDiff, 360 - accentHueDiff)).toBeLessThanOrEqual(35);

    // It should still be a proper dark surface, not brown/gray.
    expect(luminance(result.ui.dark.surface)).toBeGreaterThanOrEqual(24);
    expect(luminance(result.ui.dark.surface)).toBeLessThan(70);
  });
});
