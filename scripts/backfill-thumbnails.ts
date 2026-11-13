/**
 * Backfill missing thumbnails for all images in the database.
 *
 * Usage:  bun run backfill-thumbnails
 *
 * Generates two thumbnail tiers per image:
 *   - _thumb_sm_v2.{webp,avif}  (small, default 300px — cards, avatars)
 *   - _thumb_lg_v2.{webp,avif}  (large, default 700px — portrait panel, editor)
 *
 * Reads tier sizes from the `thumbnailSettings` setting in the DB (if set),
 * otherwise uses the defaults. Runs concurrently in batches for speed.
 */

import sharp from "sharp";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { writeInsideAvif, writeInsideWebp } from "../src/utils/image-pipeline";
import { currentWorkerBudget, deriveThumbnailSharpConcurrency } from "../src/utils/cpu-budget";

const DATA_DIR = process.env.DATA_DIR || "data";
const DB_PATH = join(DATA_DIR, "lumiverse.db");
const IMAGES_DIR = join(DATA_DIR, "images");
const DEFAULT_SMALL = 300;
const DEFAULT_LARGE = 700;

function configuredInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

if (!existsSync(IMAGES_DIR)) {
  mkdirSync(IMAGES_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// Read tier sizes from first user's thumbnailSettings, or use defaults
let smallSize = DEFAULT_SMALL;
let largeSize = DEFAULT_LARGE;
const settingRow = db
  .query("SELECT value FROM settings WHERE key = 'thumbnailSettings' LIMIT 1")
  .get() as any;
if (settingRow) {
  try {
    const parsed = JSON.parse(settingRow.value);
    smallSize = parsed.smallSize ?? DEFAULT_SMALL;
    largeSize = parsed.largeSize ?? DEFAULT_LARGE;
  } catch {}
}

console.log(`Thumbnail sizes: small=${smallSize}px, large=${largeSize}px`);

const sharpSettingRow = db
  .query("SELECT value FROM settings WHERE key = 'sharpSettings' LIMIT 1")
  .get() as { value: string } | null;
let sharpSettings: Record<string, unknown> = {};
try {
  sharpSettings = sharpSettingRow ? JSON.parse(sharpSettingRow.value) : {};
} catch {}
const codec = sharpSettings.thumbnailCodec === "avif" ? "avif" : "webp";
const quality = configuredInt(
  sharpSettings[codec === "avif" ? "avifQuality" : "webpQuality"],
  codec === "avif" ? 54 : 80,
  1,
  100,
);
const sharpConcurrency = configuredInt(
  sharpSettings.concurrency,
  deriveThumbnailSharpConcurrency(codec, currentWorkerBudget().sharpConcurrency),
  1,
  16,
);
const batchConcurrency = sharpConcurrency;
sharp.concurrency(sharpConcurrency);
sharp.cache({
  memory: configuredInt(sharpSettings.cacheMemoryMb, 64, 8, 512),
  files: configuredInt(sharpSettings.cacheFiles, 128, 0, 2048),
  items: configuredInt(sharpSettings.cacheItems, 256, 1, 4096),
});
console.log(`Thumbnail encoding: ${codec.toUpperCase()} quality=${quality}, concurrency=${sharpConcurrency}`);

interface ImageRow {
  id: string;
  filename: string;
  has_thumbnail: number;
}

const tiers = [
  { suffix: `_thumb_sm_v2.${codec}`, size: smallSize },
  { suffix: `_thumb_lg_v2.${codec}`, size: largeSize },
] as const;

// Find images missing any tier file on disk
const allImages = db
  .query("SELECT id, filename, has_thumbnail FROM images WHERE skip_thumbnail_processing = 0")
  .all() as ImageRow[];
const needsWork = allImages.filter((img) => {
  return tiers.some((t) => !existsSync(join(IMAGES_DIR, `${img.id}${t.suffix}`)));
});

if (needsWork.length === 0) {
  console.log("All images already have both thumbnail tiers. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${needsWork.length} images needing thumbnail generation (out of ${allImages.length} total).\n`);

const updateStmt = db.prepare("UPDATE images SET has_thumbnail = 1 WHERE id = ?");
let generated = 0;
let skipped = 0;
let failed = 0;

async function processImage(img: ImageRow): Promise<void> {
  const originalPath = join(IMAGES_DIR, img.filename);

  if (!existsSync(originalPath)) {
    skipped++;
    return;
  }

  let anySuccess = false;

  for (const tier of tiers) {
    const outPath = join(IMAGES_DIR, `${img.id}${tier.suffix}`);
    if (existsSync(outPath)) continue;

    try {
      if (codec === "avif") {
        await writeInsideAvif(originalPath, outPath, tier.size, tier.size, quality, {
          withoutEnlargement: true,
        });
      } else {
        await writeInsideWebp(originalPath, outPath, tier.size, tier.size, quality, {
          withoutEnlargement: true,
        });
      }
      anySuccess = true;
    } catch {
      failed++;
    }
  }

  if (anySuccess) {
    updateStmt.run(img.id);
    generated++;
  }
}

// Process in batches
const start = performance.now();
for (let i = 0; i < needsWork.length; i += batchConcurrency) {
  const batch = needsWork.slice(i, i + batchConcurrency);
  await Promise.all(batch.map(processImage));
  const progress = Math.min(i + batchConcurrency, needsWork.length);
  process.stdout.write(`\r  Processing... ${progress}/${needsWork.length}`);
}
const elapsed = (performance.now() - start).toFixed(0);

console.log(`\n\nDone in ${elapsed}ms:`);
console.log(`  Generated: ${generated}`);
if (skipped > 0) console.log(`  Skipped (missing original): ${skipped}`);
if (failed > 0) console.log(`  Failed: ${failed}`);

db.close();
