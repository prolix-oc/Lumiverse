/**
 * Server-side color extraction from images using sharp.
 *
 * Thin wrapper around src/utils/color-engine.ts: the pure algorithm lives in
 * the engine so it can be reused by the Spindle worker runtime without pulling
 * in sharp or the database.
 */

import sharp from "../utils/sharp-config";
import { join } from "path";
import { env } from "../env";
import { getDb } from "../db/connection";
import * as engine from "../utils/color-engine";

export type RGB = engine.RGB;
export type HSL = engine.HSL;
export type ReadableColorScheme = engine.ReadableColorScheme;
export type ColorSwatch = engine.ColorSwatch;
export type ColorSwatches = engine.ColorSwatches;
export type AmbientGradient = engine.AmbientGradient;
export type CharacterColorOverlay = engine.CharacterColorOverlay;
export type ColorExtractionResult = engine.ColorExtractionData;

export const rgbToHsl = engine.rgbToHsl;
export const hslToRgb = engine.hslToRgb;
export const relativeLuminance = engine.relativeLuminance;
export const contrastRatio = engine.contrastRatio;
export const rgbToLab = engine.rgbToLab;
export const labToRgb = engine.labToRgb;
export const deltaE = engine.deltaE;
export const ensureContrast = engine.ensureContrast;
export const constrainLuminance = engine.constrainLuminance;
export const extractColorsFromRawPixels = engine.extractColorsFromRawPixels;
export const deriveCharacterOverlay = engine.deriveCharacterOverlay;
export const deriveCharacterNameVars = engine.deriveCharacterNameVars;

const SAMPLE_SIZE = 64;

/**
 * Extract color palette from an image stored in the images table.
 */
export async function extractColorsFromImage(imageId: string): Promise<ColorExtractionResult> {
  const row = getDb().query("SELECT filename FROM images WHERE id = ?").get(imageId) as { filename: string } | null;
  if (!row) throw new Error(`Image not found: ${imageId}`);

  const imagesDir = join(env.dataDir, "images");
  const filePath = join(imagesDir, row.filename);
  const resized = sharp(filePath).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "cover" });
  const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  return extractColorsFromRawPixels(data, info.width, info.height, info.channels);
}
