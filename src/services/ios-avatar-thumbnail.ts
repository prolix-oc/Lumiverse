import sharp from "sharp";

/** Native presentations use bounded images owned by the requesting account. */
export async function iosAvatarThumbnail(userId: string, characterId: string, portrait = false): Promise<Response> {
  const unavailable = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const [characters, files, images] = await Promise.all([
    import("./characters.service"), import("./files.service"), import("./images.service"),
  ]);
  const info = characters.getCharacterAvatarInfo(userId, characterId);
  if (!info) return unavailable(404);
  let filepath: string | null = null;
  // Portrait cards retain the full character image; compact native avatars use
  // the user's square crop. Both fall back when the preferred image is absent.
  for (const id of portrait ? [info.image_id, info.avatar_crop_image_id] : [info.avatar_crop_image_id, info.image_id]) {
    if (id) filepath = await images.getImageFilePath(userId, id, "sm");
    if (filepath) break;
  }
  if (!filepath && info.avatar_path) filepath = await files.getAvatarPath(info.avatar_path);
  if (!filepath) return unavailable(404);
  const file = Bun.file(filepath);
  if (file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(file.type))
    return unavailable(415);
  try {
    const thumbnail = await sharp(await file.arrayBuffer(), { limitInputPixels: 16_000_000 })
      .rotate().resize(portrait ? 192 : 128, portrait ? 256 : 128, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer();
    return new Response(new Uint8Array(thumbnail), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return unavailable(415); }
}
