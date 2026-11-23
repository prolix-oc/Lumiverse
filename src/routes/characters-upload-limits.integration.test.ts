import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import sharp from "sharp";

const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-character-upload-limits-"));
process.env.DATA_DIR = dataDir;
process.env.FRONTEND_DIR = "";
process.env.TRUSTED_ORIGINS = "http://localhost:7860";
delete process.env.AUTH_BASE_URL;

const { initIdentity } = await import("../crypto/init");
const { initDatabase, closeDatabase } = await import("../db/connection");
const { runMigrations } = await import("../db/migrate");
await initIdentity();
const db = initDatabase(":memory:");
await runMigrations(db);
const { auth, allowCreation, CREATION_NONCE_HEADER } = await import("../auth");
await auth.$context;
// Exercise the real global body limit as well as the character routes.
const { default: app } = await import("../app");
const { embedPngTextChunk } = await import("../services/character-export.service");

const CHARACTER_ID = "large-card-target";
const DESCRIPTION = ".".repeat(11 * 1024 * 1024);
const CARD_JSON = JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: { name: "Large card", description: DESCRIPTION },
});
const PNG = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
const JPEG = await sharp(PNG).jpeg().toBuffer();
type CardFormat = "json" | "png" | "charx" | "jpeg_polyglot";

function makeLargeCard(format: CardFormat): File {
  if (format === "json") {
    return new File([CARD_JSON], "large-card.json", { type: "application/json" });
  }
  if (format === "png") {
    const png = embedPngTextChunk(PNG, "ccv3", Buffer.from(CARD_JSON).toString("base64"));
    return new File([new Uint8Array(png)], "large-card.png", { type: "image/png" });
  }
  // Store the entry without compression so the uploaded archive itself exceeds 10 MiB.
  const archive = zipSync({ "card.json": new TextEncoder().encode(CARD_JSON) }, { level: 0 });
  return format === "charx"
    ? new File([archive], "large-card.charx", { type: "application/zip" })
    : new File([new Uint8Array(JPEG), archive], "large-card.jpg", { type: "image/jpeg" });
}

let cookie: string;

beforeAll(async () => {
  const response = await auth.handler(new Request("http://localhost:7860/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", [CREATION_NONCE_HEADER]: allowCreation() },
    body: JSON.stringify({
      name: "Card upload test",
      username: "carduploadtest",
      email: "card-upload@example.test",
      password: "synthetic-card-upload-test-password",
    }),
  }));
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const { user } = await response.json();
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
    .run(CHARACTER_ID, user.id, "Original name");
});

beforeEach(() => {
  db.query("UPDATE characters SET description = 'Original description' WHERE id = ?").run(CHARACTER_ID);
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

for (const format of ["json", "png", "charx", "jpeg_polyglot"] as const) {
  test.each([
    "/api/v1/characters/preview-card-import",
    `/api/v1/characters/${CHARACTER_ID}/preview-card-update`,
    `/api/v1/characters/${CHARACTER_ID}/apply-card-update`,
  ])(`accepts a ${format} card over 10 MiB at %s`, async (path) => {
    const card = makeLargeCard(format);
    expect(card.size).toBeGreaterThan(10 * 1024 * 1024);
    const form = new FormData();
    form.set("file", card);
    form.set("selection", JSON.stringify({ fields: ["description"] }));
    const response = await app.request(`http://localhost:7860${path}`, {
      method: "POST", headers: { host: "localhost:7860", cookie }, body: form,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect((result.incoming ?? result.character).description).toBe(DESCRIPTION);
    if (path.endsWith("/apply-card-update")) {
      expect(db.query("SELECT name, description FROM characters WHERE id = ?").get(CHARACTER_ID))
        .toEqual({ name: "Original name", description: DESCRIPTION });
    } else {
      expect(result.format).toBe(format);
    }
  });
}

test("still rejects oversized ordinary character updates", async () => {
  const response = await app.request(`http://localhost:7860/api/v1/characters/${CHARACTER_ID}`, {
    method: "PUT",
    headers: { host: "localhost:7860", cookie, "content-type": "application/json" },
    body: JSON.stringify({ description: DESCRIPTION }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "Request body too large" });
});
