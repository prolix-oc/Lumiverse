import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { extractCardFromCharx } from "./character-card.service";
import { exportAsCharx } from "./character-export.service";
import { applyCharxModulesAndAssets } from "./charx-import.service";
import {
  createCharacter,
  getCharacter,
  setCharacterImage,
  updateCharacter,
} from "./characters.service";
import {
  resetDeferredImageProcessingForTests,
  uploadImage,
  waitForDeferredImageProcessing,
} from "./images.service";

const USER_ID = "charx-alternate-avatar-round-trip-user";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
  "base64",
);
const originalDataDir = env.dataDir;
let testDataDir = "";

function cardJson(name: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description: "",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "",
      character_version: "",
      extensions: {},
    },
  }));
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function uploadTestImage(name: string) {
  return uploadImage(
    USER_ID,
    new File([ONE_BY_ONE_PNG], name, { type: "image/png" }),
    { skip_thumbnail_processing: true },
  );
}

describe("CHARX alternate avatars", () => {
  beforeEach(async () => {
    resetDeferredImageProcessingForTests();
    closeDatabase();
    initDatabase(":memory:");
    const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
    getDb().run(baseline);
    getDb()
      .query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
      )
      .run(USER_ID, "CHARX Test", "charx-alternate-avatar-test@example.com");
    testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-charx-alternate-avatars-"));
    env.dataDir = testDataDir;
  });

  afterEach(async () => {
    await waitForDeferredImageProcessing();
    resetDeferredImageProcessingForTests();
    closeDatabase();
    env.dataDir = originalDataDir;
    if (testDataDir) {
      rmSync(testDataDir, { recursive: true, force: true });
      testDataDir = "";
    }
  });

  test("selects main by its stable archive key when an alternate is written first", async () => {
    const alternate = Buffer.concat([ONE_BY_ONE_PNG, Buffer.from([0xa1])]);
    const main = Buffer.concat([ONE_BY_ONE_PNG, Buffer.from([0xb2, 0xb3])]);
    const modules = new TextEncoder().encode(JSON.stringify({
      version: 1,
      alternate_avatars: [{ id: "alternate-a", label: "Alternate A", path: "assets/icon/image/alternate-a.png" }],
    }));
    const archive = zipSync({
      "card.json": cardJson("Archive Ordering"),
      "assets/icon/image/alternate-a.png": alternate,
      "assets/icon/image/main.png": main,
      "lumiverse_modules.json": modules,
    });

    const extracted = await extractCardFromCharx(
      new File([ownedBytes(archive)], "archive-ordering.charx", { type: "application/zip" }),
    );

    expect(extracted.avatarFile?.name).toBe("main.png");
    expect(Buffer.from(await extracted.avatarFile!.arrayBuffer())).toEqual(main);
  });

  test("preserves alternate avatar positions, ids, and bindings through a round trip", async () => {
    const source = createCharacter(USER_ID, { name: "Ordered Avatars" });
    const primary = await uploadTestImage("primary.png");
    const first = await uploadTestImage("first.png");
    const second = await uploadTestImage("second.png");
    const third = await uploadTestImage("third.png");
    setCharacterImage(USER_ID, source.id, primary.id);
    updateCharacter(USER_ID, source.id, {
      extensions: {
        alternate_avatars: [
          { id: "first-avatar", image_id: first.id, label: "First" },
          { id: "second-avatar", image_id: second.id, label: "Second" },
          { id: "third-avatar", image_id: third.id, label: "Third" },
        ],
        avatar_bindings: {
          "first-avatar": { greeting_index: 0 },
          "second-avatar": { description: null },
          "third-avatar": { scenario: "night-scenario" },
        },
      },
    });

    const archive = await exportAsCharx(USER_ID, source.id);
    expect(archive).not.toBeNull();
    const extracted = await extractCardFromCharx(
      new File([ownedBytes(archive!)], "ordered-avatars.charx", { type: "application/zip" }),
    );

    expect(extracted.lumiverseModules?.alternate_avatars?.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "first-avatar", label: "First" },
      { id: "second-avatar", label: "Second" },
      { id: "third-avatar", label: "Third" },
    ]);

    const imported = createCharacter(USER_ID, extracted.card);
    await applyCharxModulesAndAssets(USER_ID, imported, extracted);
    await waitForDeferredImageProcessing();

    const roundTripped = getCharacter(USER_ID, imported.id)!;
    expect(roundTripped.extensions.alternate_avatars.map(({ id, label }: any) => ({ id, label }))).toEqual([
      { id: "first-avatar", label: "First" },
      { id: "second-avatar", label: "Second" },
      { id: "third-avatar", label: "Third" },
    ]);
    expect(roundTripped.extensions.avatar_bindings).toEqual({
      "first-avatar": { greeting_index: 0 },
      "second-avatar": { description: null },
      "third-avatar": { scenario: "night-scenario" },
    });
  });
});
