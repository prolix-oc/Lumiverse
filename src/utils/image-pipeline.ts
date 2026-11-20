import sharp from "./sharp-config";

export type ImagePipelineInput = string | ArrayBuffer | NodeJS.TypedArray | Blob;

export interface ImagePipelineMetadata {
  width: number | null;
  height: number | null;
  format: string | null;
}

interface ImagePipelineOptions {
  autoOrient?: boolean;
}

/**
 * Prefer Bun's off-thread native image pipeline for the operations it supports,
 * while retaining Sharp as a compatibility fallback for inputs such as SVG.
 */
export async function readImageMetadata(
  input: ImagePipelineInput,
  options: ImagePipelineOptions = {},
): Promise<ImagePipelineMetadata> {
  try {
    const metadata = await new Bun.Image(input, {
      autoOrient: options.autoOrient ?? false,
    }).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  } catch {
    const metadata = await sharp(input as any).metadata();
    // Sharp names the decoder/container; AV1 compression identifies AVIF.
    const format = metadata.format === "heif" && metadata.compression === "av1"
      ? "avif"
      : metadata.format ?? null;
    return {
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      format,
    };
  }
}

export async function resizeInsideToWebp(
  input: ImagePipelineInput,
  width: number,
  height: number,
  quality: number,
  options: ImagePipelineOptions & { withoutEnlargement?: boolean } = {},
): Promise<Buffer> {
  const autoOrient = options.autoOrient ?? false;
  const withoutEnlargement = options.withoutEnlargement ?? false;
  try {
    return await new Bun.Image(input, { autoOrient })
      .resize(width, height, { fit: "inside", withoutEnlargement })
      .webp({ quality })
      .buffer();
  } catch {
    let pipeline = sharp(input as any);
    if (autoOrient) pipeline = pipeline.rotate();
    return pipeline
      .resize(width, height, { fit: "inside", withoutEnlargement })
      .webp({ quality })
      .toBuffer();
  }
}

export async function writeInsideWebp(
  input: ImagePipelineInput,
  destination: string,
  width: number,
  height: number,
  quality: number,
  options: ImagePipelineOptions & { withoutEnlargement?: boolean } = {},
): Promise<void> {
  const autoOrient = options.autoOrient ?? false;
  const withoutEnlargement = options.withoutEnlargement ?? false;
  try {
    await new Bun.Image(input, { autoOrient })
      .resize(width, height, { fit: "inside", withoutEnlargement })
      .webp({ quality })
      .write(destination);
  } catch {
    let pipeline = sharp(input as any);
    if (autoOrient) pipeline = pipeline.rotate();
    await pipeline
      .resize(width, height, { fit: "inside", withoutEnlargement })
      .webp({ quality })
      .toFile(destination);
  }
}

/**
 * AVIF output always uses Sharp/libvips. Unlike WebP, Bun.Image does not
 * currently expose an AVIF encoder. Sharp's process-wide cache and concurrency
 * limits are configured by sharp-settings.service through the shared module.
 */
export async function writeInsideAvif(
  input: ImagePipelineInput,
  destination: string,
  width: number,
  height: number,
  quality: number,
  options: ImagePipelineOptions & { withoutEnlargement?: boolean } = {},
): Promise<void> {
  const autoOrient = options.autoOrient ?? false;
  const withoutEnlargement = options.withoutEnlargement ?? false;
  let pipeline = sharp(input as any);
  if (autoOrient) pipeline = pipeline.rotate();
  await pipeline
    .resize(width, height, { fit: "inside", withoutEnlargement })
    .avif({ quality, effort: 4, chromaSubsampling: "4:2:0" })
    .toFile(destination);
}

export async function convertImageToWebp(
  input: ImagePipelineInput,
  quality: number,
  options: ImagePipelineOptions = {},
): Promise<Buffer> {
  const autoOrient = options.autoOrient ?? false;
  try {
    return await new Bun.Image(input, { autoOrient })
      .webp({ quality })
      .buffer();
  } catch {
    let pipeline = sharp(input as any);
    if (autoOrient) pipeline = pipeline.rotate();
    return pipeline.webp({ quality }).toBuffer();
  }
}

export async function convertImageToPng(
  input: ImagePipelineInput,
  options: ImagePipelineOptions = {},
): Promise<Buffer> {
  const autoOrient = options.autoOrient ?? false;
  try {
    return await new Bun.Image(input, { autoOrient }).png().buffer();
  } catch {
    let pipeline = sharp(input as any);
    if (autoOrient) pipeline = pipeline.rotate();
    return pipeline.png().toBuffer();
  }
}
