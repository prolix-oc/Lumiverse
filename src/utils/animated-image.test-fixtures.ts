import { crc32, deflateSync } from "node:zlib";
import sharp from "./sharp-config";

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export type TestFrame = { color: number[]; x?: number; y?: number; width?: number; height?: number; dispose?: number; blend?: number; delay?: number };
export function animatedPng(frames: TestFrame[] = [{ color: [255, 0, 0, 255], delay: 100 }, { color: [0, 0, 255, 255], delay: 250 }], poster = false, loop = 3): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const control = Buffer.alloc(8); control.writeUInt32BE(frames.length, 0); control.writeUInt32BE(loop, 4);
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', control)];
  let sequence = 0;
  const pixels = (width: number, height: number, color: number[]) => {
    const data = Buffer.alloc((1 + width * 4) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color, y * (1 + width * 4) + 1 + x * 4);
    return deflateSync(data);
  };
  if (poster) chunks.push(chunk('IDAT', pixels(16, 16, [0, 255, 0, 255])));
  frames.forEach((frame, i) => {
    const width = frame.width ?? 16, height = frame.height ?? 16;
    const f = Buffer.alloc(26); f.writeUInt32BE(sequence++, 0); f.writeUInt32BE(width, 4); f.writeUInt32BE(height, 8);
    f.writeUInt32BE(frame.x ?? 0, 12); f.writeUInt32BE(frame.y ?? 0, 16); f.writeUInt16BE(frame.delay ?? 100, 20); f.writeUInt16BE(1000, 22);
    f[24] = frame.dispose ?? 0; f[25] = frame.blend ?? 0; chunks.push(chunk('fcTL', f));
    const data = pixels(width, height, frame.color);
    if (!i && !poster) chunks.push(chunk('IDAT', data));
    else { const s = Buffer.alloc(4); s.writeUInt32BE(sequence++); chunks.push(chunk('fdAT', Buffer.concat([s, data]))); }
  });
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

export async function animatedWebp(loop = 3): Promise<Buffer> {
  const frames = Buffer.alloc(16 * 32 * 4);
  for (let i = 0; i < 16 * 32; i++) frames.set(i < 16 * 16 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  return sharp(frames, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } })
    .webp({ lossless: true, loop, delay: [100, 250] }).toBuffer();
}
