import sharp from "sharp";
import { notificationPlainText } from "../utils/notification-text";
import type { LiveActivityPresentation } from "../spindle/live-activities-contract";

export interface ActivityCard {
  layout: "status" | "progress" | "image";
  title: string;
  body: string;
  symbol: string;
  progress?: number;
  imageBase64?: string;
}
export async function activityCard(userId: string, value: unknown): Promise<ActivityCard> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Live Activity presentation");
  const input = value as LiveActivityPresentation;
  if (!["status", "progress", "image"].includes(input.layout)) throw new Error("Unknown Live Activity layout");
  if (typeof input.title !== "string" || !notificationPlainText(input.title, 80)) throw new Error("Live Activity title is required");
  if (input.body !== undefined && typeof input.body !== "string") throw new Error("Invalid Live Activity body");
  if (input.symbol !== undefined && (typeof input.symbol !== "string" || !/^[a-z0-9.]{1,64}$/.test(input.symbol)))
    throw new Error("Invalid SF Symbol name");
  if (input.layout !== "progress" && input.progress !== undefined) throw new Error("Progress requires the progress layout");
  if (input.layout !== "image" && input.imageId !== undefined) throw new Error("Images require the image layout");
  const card: ActivityCard = { layout: input.layout, title: notificationPlainText(input.title, 80),
    body: notificationPlainText(input.body, 160), symbol: input.symbol ?? ({ status: "bell.fill", progress: "hourglass", image: "photo" })[input.layout] };
  if (input.layout === "progress") {
    if (typeof input.progress !== "number" || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1)
      throw new Error("Live Activity progress must be between 0 and 1");
    card.progress = input.progress;
  }
  if (input.layout === "image") {
    if (typeof input.imageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.imageId)) throw new Error("Invalid image ID");
    const { getImageFilePath } = await import("./images.service");
    const path = await getImageFilePath(userId, input.imageId, "sm");
    if (!path) throw new Error("Image not found or not owned by this user");
    const file = Bun.file(path);
    if (file.size > 8 * 1024 * 1024) throw new Error("Image source is too large");
    const bytes = await file.arrayBuffer();
    // A complete encrypted snapshot must fit even when the app cannot download.
    // Try a useful preview first, then progressively reduce the thumbnail.
    for (const size of [64, 48, 32]) {
      const image = await sharp(bytes, { limitInputPixels: 16_000_000 }).rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 40 }).toBuffer();
      if (image.length <= 700) { card.imageBase64 = image.toString("base64"); break; }
    }
    // An image that cannot fit degrades to the native photo placeholder.
  }
  return card;
}
