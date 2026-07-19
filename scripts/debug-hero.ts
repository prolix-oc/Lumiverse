import sharp from 'sharp';
import { extractColorsFromRawPixels, contrastRatio } from '../src/services/color-extraction.service';
import type { RGB } from '../src/services/color-extraction.service';
import { deriveHeroTextVars } from '../frontend/src/lib/characterTheme';
import { extractTextZoneFromData } from '../frontend/src/lib/colorExtraction';
import type { TextZoneCluster } from '../frontend/src/lib/colorExtraction';

function luminance(c: RGB): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

function parseRgbVar(value: string): RGB {
  const m = value.match(/^rgb\((\d+) (\d+) (\d+)\)$/);
  if (!m) throw new Error(`Not an rgb() var: ${value}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function composite(surface: RGB, clusterColor: RGB, alpha: number): RGB {
  return {
    r: Math.round(surface.r + (clusterColor.r - surface.r) * alpha),
    g: Math.round(surface.g + (clusterColor.g - surface.g) * alpha),
    b: Math.round(surface.b + (clusterColor.b - surface.b) * alpha),
  };
}

async function analyze(path: string) {
  const { data, info } = await sharp(path)
    .resize(64, 64, { fit: 'cover' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8ClampedArray(data);
  const result = extractColorsFromRawPixels(pixels, info.width, info.height, 4);
  const textZone = extractTextZoneFromData(pixels, info.width, info.height);
  const palette = { ...result, textZone } as any;

  const fmt = (c: RGB) => `rgb(${c.r},${c.g},${c.b}) lum=${Math.round(luminance(c))}`;
  const fmtClusters = (clusters: TextZoneCluster[]) =>
    clusters.length === 0
      ? '  (empty)'
      : clusters
          .map((c) => `  ${fmt(c.color)}  w=${c.weight.toFixed(2)} α=${c.alpha.toFixed(2)}`)
          .join('\n');

  console.log(`\n=== ${path} ===`);
  console.log('textZone.name clusters:\n' + fmtClusters(textZone.name.clusters));
  console.log('textZone.meta clusters:\n' + fmtClusters(textZone.meta.clusters));

  const vars = deriveHeroTextVars(palette);
  console.log('Hero text vars:', vars);

  // Verify: worst-case contrast of the chosen name/meta text against the
  // composited backings, per mode.
  for (const mode of ['dark', 'light'] as const) {
    const surface = palette.ui[mode].surface;
    const nameText = parseRgbVar(vars[`--hero-contrast-name-${mode}`]);
    const metaText = parseRgbVar(vars[`--hero-contrast-${mode}`]);
    const worst = (text: RGB, clusters: TextZoneCluster[]) =>
      clusters.length === 0
        ? contrastRatio(text, surface)
        : Math.min(...clusters.map((c) => contrastRatio(text, composite(surface, c.color, c.alpha))));
    console.log(
      `[${mode}] name ${fmt(nameText)} worst=${worst(nameText, textZone.name.clusters).toFixed(2)} | ` +
      `meta ${fmt(metaText)} worst=${worst(metaText, textZone.meta.clusters).toFixed(2)} | ` +
      `bimodal=${vars[`--hero-text-bimodal-${mode}`]}`
    );
  }
}

await analyze('/Users/darranhall/Downloads/cissia_test.webp');
await analyze('/Users/darranhall/Downloads/kairo_test.webp');
