import { crc32 } from "node:zlib";
import sharp from "./sharp-config";
import type { Sharp } from "sharp";
import { imageAnimationType, type ImageAnimationType } from "../shared/image-animation";

type Input = string | ArrayBuffer | NodeJS.TypedArray | Blob;
export interface ImageCrop { x: number; y: number; width: number; height: number }
interface Transform { width: number; height: number; quality: number; crop?: ImageCrop; withoutEnlargement?: boolean }

// Bound the output stack and cumulative decoding work before allocating pixels.
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const MAX_FRAMES = 1000;
const animationTypes = new Map<string, Promise<ImageAnimationType | null>>();

async function inspectFileAnimation(path: string): Promise<ImageAnimationType | null> {
  const file = Bun.file(path);
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (head[0] !== 137 || head[1] !== 80 || head[2] !== 78 || head[3] !== 71) return imageAnimationType(head);
  // Skip PNG metadata and compressed pixels without reading a large card into
  // memory just to choose the thumbnail codec. acTL must precede IDAT.
  for (let offset = 8; offset + 12 <= file.size;) {
    const record = Buffer.from(await file.slice(offset, offset + 20).arrayBuffer());
    const length = record.readUInt32BE(0), type = record.toString("ascii", 4, 8);
    if (length > file.size - offset - 12) return null;
    if (type === "acTL") return length === 8 && record.readUInt32BE(8) > 0 ? "apng" : null;
    if (type === "IDAT" || type === "IEND") return null;
    offset += length + 12;
  }
  return null;
}

export async function imageBytes(input: Input): Promise<Buffer> {
  if (typeof input === "string") return Buffer.from(await Bun.file(input).arrayBuffer());
  if (input instanceof Blob) return Buffer.from(await input.arrayBuffer());
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input);
}

/** Image files are immutable, UUID-named originals. Keep only a bounded hint cache. */
export async function readImageAnimationType(input: Input): Promise<ImageAnimationType | null> {
  if (typeof input !== "string") return imageAnimationType(await imageBytes(input));
  let hint = animationTypes.get(input);
  if (!hint) {
    hint = inspectFileAnimation(input).catch(error => {
      animationTypes.delete(input);
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    animationTypes.set(input, hint);
    if (animationTypes.size > 1024) animationTypes.delete(animationTypes.keys().next().value!);
    hint.catch(() => animationTypes.delete(input));
  }
  return hint;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function transformFrame(pipeline: Sharp, options: Transform): Sharp {
  if (options.crop) {
    const { x, y, width, height } = options.crop;
    pipeline = pipeline.extract({ left: x, top: y, width, height });
  }
  return pipeline.resize(options.width, options.height, {
    fit: options.crop ? "fill" : "inside",
    withoutEnlargement: options.withoutEnlargement ?? false,
  });
}

export function validateImageCrop(crop: ImageCrop, width: number, height: number): void {
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger)
    || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1
    || crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error("Invalid image crop bounds");
  }
}

/** Decode APNG frame rectangles with Sharp, then apply APNG blend/disposal rules.
 * The default IDAT image can be a separate poster; only fcTL-controlled frames
 * belong to the animation. No text/card metadata is copied to previews.
 * https://www.w3.org/TR/png-3/#animation
 */
async function transformApng(bytes: Buffer, options: Transform): Promise<Buffer> {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_FRAME_PIXELS) throw new Error("Animation canvas is too large");
  if (options.crop) validateImageCrop(options.crop, width, height);
  const header = Buffer.from(bytes.subarray(16, 29));
  const shared: Buffer[] = [];
  type Frame = { width: number; height: number; x: number; y: number; delay: number; dispose: number; blend: number; chunks: Buffer[] };
  const frames: Frame[] = [];
  let current: Frame | undefined, count = 0, loop = 0, sequence = 0, ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated animated PNG");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (["IHDR", "acTL", "fcTL", "fdAT", "IDAT", "PLTE", "tRNS"].includes(type)
      && crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error("Invalid PNG checksum");
    if (type === "acTL") {
      if (length !== 8 || count) throw new Error("Invalid animation control");
      count = data.readUInt32BE(0); loop = data.readUInt32BE(4);
      if (!count || count > MAX_FRAMES || width * height * count > MAX_PIXELS * 4) throw new Error("Animation is too large");
    } else if (type === "fcTL") {
      if (length !== 26 || data.readUInt32BE(0) !== sequence++) throw new Error("Invalid animation sequence");
      current = { width: data.readUInt32BE(4), height: data.readUInt32BE(8), x: data.readUInt32BE(12), y: data.readUInt32BE(16),
        delay: Math.max(10, Math.round(1000 * data.readUInt16BE(20) / (data.readUInt16BE(22) || 100))),
        dispose: data[24], blend: data[25], chunks: [] };
      validateImageCrop(current, width, height);
      if (current.dispose > 2 || current.blend > 1 || frames.length >= count) throw new Error("Invalid animation frame");
      frames.push(current);
    } else if (type === "IDAT" && current) {
      current.chunks.push(pngChunk("IDAT", data));
    } else if (type === "fdAT") {
      if (!current || length < 4 || data.readUInt32BE(0) !== sequence++) throw new Error("Invalid animation data");
      current.chunks.push(pngChunk("IDAT", data.subarray(4)));
    } else if (["PLTE", "tRNS", "iCCP", "sRGB", "gAMA", "cHRM"].includes(type)) {
      shared.push(bytes.subarray(offset, end));
    } else if (type === "IEND") { ended = true; break; }
    offset = end;
  }
  if (!ended || frames.length !== count || !count) throw new Error("Incomplete animated PNG");
  let canvas = Buffer.alloc(width * height * 4);
  const output: Buffer[] = [], delay: number[] = [];
  let outWidth = 0, outHeight = 0;
  for (const frame of frames) {
    if (!frame.chunks.length) throw new Error("Missing animation frame pixels");
    header.writeUInt32BE(frame.width, 0); header.writeUInt32BE(frame.height, 4);
    const png = Buffer.concat([bytes.subarray(0, 8), pngChunk("IHDR", header), ...shared, ...frame.chunks, pngChunk("IEND", Buffer.alloc(0))]);
    const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
    const previous = frame.dispose === 2 ? Buffer.from(canvas) : null;
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const src = (y * frame.width + x) * 4, dst = ((y + frame.y) * width + x + frame.x) * 4;
      const alpha = pixels[src + 3] / 255;
      if (frame.blend === 0 || alpha === 1) pixels.copy(canvas, dst, src, src + 4);
      else if (alpha > 0) {
        const remaining = (canvas[dst + 3] / 255) * (1 - alpha), result = alpha + remaining;
        for (let c = 0; c < 3; c++) canvas[dst + c] = Math.round((pixels[src + c] * alpha + canvas[dst + c] * remaining) / result);
        canvas[dst + 3] = Math.round(result * 255);
      }
    }
    const rendered = await transformFrame(sharp(canvas, { raw: { width, height, channels: 4 } }), options).raw().toBuffer({ resolveWithObject: true });
    outWidth = rendered.info.width; outHeight = rendered.info.height;
    if (outWidth * outHeight * count > MAX_PIXELS) throw new Error("Animation output is too large");
    output.push(rendered.data); delay.push(frame.delay);
    if (previous) canvas = previous;
    else if (frame.dispose === 1) for (let y = frame.y; y < frame.y + frame.height; y++) canvas.fill(0, (y * width + frame.x) * 4, (y * width + frame.x + frame.width) * 4);
  }
  return sharp(Buffer.concat(output), { raw: { width: outWidth, height: outHeight * count, channels: 4, pageHeight: outHeight } })
    .webp({ quality: options.quality, loop: Math.min(loop, 65535), delay }).toBuffer();
}

export async function transformAnimatedImage(input: Input, options: Transform): Promise<Buffer> {
  const bytes = await imageBytes(input);
  const type = imageAnimationType(bytes);
  if (type === "apng") return transformApng(bytes, options);
  if (type !== "webp") throw new Error("Expected an animated WebP or PNG");
  const metadata = await sharp(bytes).metadata();
  if ((metadata.pages ?? 1) > MAX_FRAMES || (metadata.width ?? 0) * (metadata.height ?? 0) * (metadata.pages ?? 1) > MAX_PIXELS) throw new Error("Animation is too large");
  if (options.crop) validateImageCrop(options.crop, metadata.width!, metadata.pageHeight ?? metadata.height!);
  return transformFrame(sharp(bytes, { animated: true }), options).webp({ quality: options.quality }).toBuffer();
}
