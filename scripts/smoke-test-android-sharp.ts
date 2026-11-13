import { resolve } from "node:path";
import { configureSharpNativeOverride } from "../src/sharp-preflight";

if (process.platform !== "android" || process.arch !== "arm64") {
  throw new Error("Run this smoke test using native Android ARM64 Bun.");
}
// A local archive exercises the same checksum/installation path before release.
const archive = process.argv[2];
await configureSharpNativeOverride({ workspaceRoot: resolve(import.meta.dir, ".."),
  fetchBundle: archive ? async () => new Response(Bun.file(resolve(archive))) : undefined });
const { default: sharp } = await import("sharp");
for (const format of ["png", "jpeg", "webp", "avif", "gif", "tiff", "jxl"] as const) {
  const encoded = await sharp({ create: { width: 16, height: 16, channels: 4, background: "purple" } })
    .resize(8, 8).toFormat(format).toBuffer();
  const decoded = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== 8 || decoded.info.height !== 8 || !decoded.data.length) {
    throw new Error(`Android Sharp ${format} round-trip failed`);
  }
  console.log(`${format}: encode, resize and decode passed`);
}
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="purple"/></svg>');
const rasterized = await sharp(svg).resize(8, 8).png().toBuffer();
if ((await sharp(rasterized).metadata()).width !== 8) throw new Error("Android SVG rasterization failed");
console.log("svg: rasterize and resize passed");
await sharp(Buffer.from("invalid image")).toBuffer().then(
  () => { throw new Error("Malformed image was accepted"); },
  () => console.log("malformed input: rejected"),
);
console.log(`Bun ${Bun.version} ${process.platform}-${process.arch}; Sharp ${sharp.versions.sharp}; libvips ${sharp.versions.vips}`);
