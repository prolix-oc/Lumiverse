import { afterAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const db = new Database(":memory:");
db.exec(await Bun.file(new URL("../db/migrations/117_desktop_notification_destinations.sql", import.meta.url)).text());
const fixtureDir = await mkdtemp(join(tmpdir(), "lumiverse-notification-media-"));
const fixturePath = join(fixtureDir, "avatar.png");
await Bun.write(
  fixturePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+Xn1mAAAAAElFTkSuQmCC",
    "base64",
  ),
);

mock.module("../db/connection", () => ({
  getDb: () => db,
  getDatabasePath: () => ":memory:",
  onDbReset: () => {},
}));
mock.module("../crypto/vapid", () => ({
  getVapidPrivateJWK: () => ({}),
  getVapidPublicKey: () => "desktop-media-test-key",
}));
mock.module("../services/characters.service", () => ({
  getCharacterAvatarInfo: (userId: string, id: string) => (
    userId === "media-user" && id === "char-1"
      ? { avatar_crop_image_id: "avatar-image", image_id: null, avatar_path: null }
      : null
  ),
}));
mock.module("../services/files.service", () => ({ getAvatarPath: async () => null }));
mock.module("../services/images.service", () => ({
  getImage: (userId: string, id: string) => (
    userId === "media-user" && id === "image-1"
      ? { id: "image-1", mime_type: "image/png" }
      : null
  ),
  getImageAsync: async (userId: string, id: string) => (
    userId === "media-user" && id === "image-1"
      ? { id: "image-1", mime_type: "image/png" }
      : null
  ),
  getImageFilePath: async (userId: string, id: string) => (
    userId === "media-user" && ["avatar-image", "image-1"].includes(id)
      ? fixturePath
      : null
  ),
}));

const { createDesktopDestination } = await import("../services/push.service");
const { desktopNotificationTransportRoutes } = await import("./desktop-notifications.routes");
const app = new Hono();
app.route("/desktop-notifications", desktopNotificationTransportRoutes);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  db.close();
  mock.restore();
});

test("serves a user-owned character avatar to its enrolled desktop destination", async () => {
  const enrollment = createDesktopDestination("media-user", {
    deviceId: "desktop-media-device-character",
  });
  const response = await app.request(
    "/desktop-notifications/media?path=%2Fapi%2Fv1%2Fcharacters%2Fchar-1%2Favatar%3Fsize%3Dsm",
    { headers: { authorization: `Bearer ${enrollment.credential}` } },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
});

test("serves an owned image and rejects another user's asset", async () => {
  const enrollment = createDesktopDestination("media-user", {
    deviceId: "desktop-media-device-image",
  });
  const headers = { authorization: `Bearer ${enrollment.credential}` };
  const owned = await app.request(
    "/desktop-notifications/media?path=%2Fapi%2Fv1%2Fimages%2Fimage-1%3Fsize%3Dlg",
    { headers },
  );
  const missing = await app.request(
    "/desktop-notifications/media?path=%2Fapi%2Fv1%2Fimages%2Fsomeone-elses-image",
    { headers },
  );

  expect(owned.status).toBe(200);
  expect(missing.status).toBe(404);
});
