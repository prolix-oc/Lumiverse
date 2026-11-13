import { afterAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

const db = new Database(":memory:");
db.exec("CREATE TABLE ios_push_destinations (id TEXT PRIMARY KEY, user_id TEXT)");
db.query("INSERT INTO ios_push_destinations VALUES (?, ?)").run("phone-1", "owner");
const directory = await mkdtemp(join(tmpdir(), "ios-avatar-test-"));
const filepath = join(directory, "avatar.png");
let servedPath = filepath;
await sharp({ create: { width: 240, height: 160, channels: 3, background: "#9b7fed" } }).png().toFile(filepath);
mock.module("../db/connection", () => ({ getDb: () => db }));
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(17) }));
mock.module("../services/characters.service", () => ({
  getCharacterAvatarInfo: (user: string, id: string) => user === "owner" && id === "owned"
    ? { avatar_crop_image_id: "crop", image_id: "original", avatar_path: null } : null,
}));
mock.module("../services/images.service", () => ({
  getImageFilePath: async (user: string, id: string) => user === "owner" && id === "crop" ? servedPath : null,
}));
mock.module("../services/files.service", () => ({ getAvatarPath: async () => null }));
const { issueIOSNotificationAvatarPath, verifyIOSNotificationAvatarPath } = await import("../services/ios-notification-avatar");
const { iosNotificationMediaRoutes } = await import("./ios-notifications.routes");
const { Hono } = await import("hono");
const app = new Hono().route("/api/ios-notifications/v1", iosNotificationMediaRoutes);
afterAll(async () => { db.close(); await rm(directory, { recursive: true, force: true }); mock.restore() });

test("serves only the enrolled owner's avatar, resized to a bounded JPEG without session cookies", async () => {
  const path = issueIOSNotificationAvatarPath("phone-1", "owned");
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  const bytes = await response.arrayBuffer();
  expect(bytes.byteLength).toBeLessThan(256 * 1024);
  const metadata = await sharp(bytes).metadata();
  expect([metadata.width, metadata.height]).toEqual([128, 128]);
  expect((await app.request(issueIOSNotificationAvatarPath("phone-1", "someone-elses-character"))).status).toBe(404);
});

test("rejects missing, expired and tampered capabilities", async () => {
  const path = issueIOSNotificationAvatarPath("phone-1", "owned");
  const url = new URL(path, "https://example.test");
  for (const invalid of [url.pathname, path.replace("owned", "stolen"), path.replace("phone-1", "phone-2"),
    path.replace(/signature=./, "signature=!"), issueIOSNotificationAvatarPath("phone-1", "owned", 1000)]) {
    const response = await app.request(invalid);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const expires = url.searchParams.get("expires")!;
  expect(verifyIOSNotificationAvatarPath("phone-1", "owned", String(Number(expires) + 1), url.searchParams.get("signature")!)).toBe(false);
});

test("deleting an enrollment revokes outstanding avatar URLs", async () => {
  const path = issueIOSNotificationAvatarPath("revoked-phone", "owned");
  db.query("INSERT INTO ios_push_destinations VALUES (?, ?)").run("revoked-phone", "owner");
  expect((await app.request(path)).status).toBe(200);
  db.query("DELETE FROM ios_push_destinations WHERE id = ?").run("revoked-phone");
  expect((await app.request(path)).status).toBe(404);
});

test("rejects active content, oversized files, and invalid image bytes", async () => {
  const path = issueIOSNotificationAvatarPath("phone-1", "owned");
  try {
    for (const [name, bytes] of [["active.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
      ["large.png", Buffer.alloc(8 * 1024 * 1024 + 1)], ["invalid.png", "not an image"]] as const) {
      servedPath = join(directory, name);
      await Bun.write(servedPath, bytes);
      const response = await app.request(path);
      expect(response.status).toBe(415);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  } finally { servedPath = filepath }
});
