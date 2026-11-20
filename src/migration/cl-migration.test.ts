import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { embedPngTextChunk } from "../services/character-export.service";
import { getCharacter, updateCharacter } from "../services/characters.service";
import { getImage } from "../services/images.service";
import { listGallery } from "../services/character-gallery.service";
import { getRegexScriptsByCharacterId } from "../services/regex-scripts.service";
import { getChat, getMessages } from "../services/chats.service";
import { createWorldBook } from "../services/world-books.service";
import { getSetting, putSetting } from "../services/settings.service";
import { clMigrationRoutes } from "../routes/cl-migration.routes";
import { ArchiveValidationError } from "../services/user-data/import.service";
import { clFileSha256, safeClArchivePath, validateClManifest } from "./cl-bundle-source";
import { ClMigrationError, clMigrationArchivePath, deleteClMigrationJob, getClMigrationJob, stageClMigrationBundle, startClMigration, waitForClMigrations } from "./cl-migration.service";
import type { ClMigrationOptions, ClMigrationReport } from "./cl-types";
import * as vectorStores from "../services/vector-store";
import type { VectorStore } from "../services/vector-store/types";
import { stubVectorStore } from "../services/test-fixtures/vector-store";

const OWNER = "cl-owner";
const OTHER = "cl-other";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64");
const local = "/user/images/shared/scene.png";
let workDir = "";
let originalDataDir = "";
const deleteVectors = mock<VectorStore["deleteByFilter"]>(async () => {});
let vectorStoreSpy: ReturnType<typeof spyOn<typeof vectorStores, "getActiveVectorStore">>;

function card(description = `![Scene](${local}) ${local}.backup https://example.com${local}`) {
  return embedPngTextChunk(png, "ccv3", Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: {
    name: "Same Name", description, first_mes: `Hello ${local}`, alternate_greetings: [`Again ${local}`],
    character_book: { name: "Embedded snapshot", entries: [{ keys: ["embedded"], content: "Embedded content" }] },
    extensions: { world: "world-file", gallery_id: "shared", custom: { untouched: true }, world_book_ids: ["foreign-id"],
      regex_scripts: [{ scriptName: "Scene", findRegex: "/scene/g", replaceString: `![Scene](${local})`, placement: [2], disabled: false },
        { scriptName: "Deprecated", findRegex: "old", replaceString: "new", placement: [3] }] },
  } })).toString("base64"));
}

function fixture(description?: string): Record<string, Uint8Array> {
  const character = (avatar: string) => ({ avatar, name: "Same Name", fav: avatar === "a.png", create_date: "2024-01-01T00:00:00.000Z", chat: "First", chatFiles: avatar === "a.png" ? ["First.jsonl"] : [], primaryWorld: "world-file", auxWorlds: ["aux-file"], worlds: ["world-file", "aux-file"], gallery: { folder: "shared", files: ["scene.png"] } });
  return {
    "manifest.json": strToU8(JSON.stringify({ version: 1, generator: "SillyTavern-CharacterLibrary", characters: [character("a.png"), character("b.png")], worlds: [{ name: "world-file", file: "worlds/0.json" }, { name: "aux-file", file: "worlds/1.json" }] })),
    "cards/a.png": card(description), "cards/b.png": card(), "gallery/shared/scene.png": png,
    "worlds/0.json": strToU8(JSON.stringify({ name: "Same Book Name", entries: { 0: { key: ["primary"], content: "Primary content" } } })),
    "worlds/1.json": strToU8(JSON.stringify({ name: "Same Book Name", entries: { 0: { key: ["aux"], content: "Aux content" } } })),
    "chats/a/First.jsonl": strToU8([
      { user_name: "You", character_name: "Same Name", chat_metadata: { world_info: "aux-file", custom_note: "kept", persona_id: "foreign-persona" } },
      { name: "You", is_user: true, mes: "Hi", send_date: "2024-01-01T00:00:00.000Z", extra: { custom: "original" } },
      { name: "Same Name", is_user: false, mes: `![Scene](${local})`, send_date: "2024-01-01T00:01:00.000Z", swipes: ["First", `Second ${local}`], swipe_id: 1, extra: { custom: "message" } },
    ].map((v) => JSON.stringify(v)).join("\n")),
    "unmodeled/custom-script.js": strToU8("console.log('preserved');"),
  };
}

function body(bytes: Uint8Array) { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }); }
async function stage(files = fixture(), userId = OWNER, sourceId?: string) {
  const bytes = zipSync(files);
  return stageClMigrationBundle({ userId, body: body(bytes), declaredSize: bytes.length, filename: "library.zip", sourceId });
}
async function execute(jobId: string, userId = OWNER, options: ClMigrationOptions = {}): Promise<ClMigrationReport> {
  startClMigration(userId, jobId, options);
  await waitForClMigrations();
  return getClMigrationJob(userId, jobId)!.report!;
}
function destination(report: ClMigrationReport, kind: string, source: string) {
  const item = report.items.find((r) => r.kind === kind && r.source === source && r.status !== "failed");
  expect(item?.destinationId).toBeTruthy();
  return item!.destinationId!;
}
function count(table: string) { return (getDb().query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
function authenticatedApp(userId = OWNER) {
  const app = new Hono();
  app.use("*", async (c, next) => { if (c.req.header("cookie") === "test-session=valid") c.set("userId", userId); await next(); });
  app.route("/api/v1/cl-migration", clMigrationRoutes);
  return app;
}

// STORE ZIP fixture, including repeated names, matching CharacterLibrary's writer.
function storedZip(entries: Array<[string, Uint8Array]>): Uint8Array {
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, bytes] of entries) {
    let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const n = Buffer.from(name); const local = Buffer.alloc(30), cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(n.length, 26);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(bytes.length, 20); cd.writeUInt32LE(bytes.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, n, Buffer.from(bytes)); central.push(cd, n); offset += local.length + n.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

beforeEach(async () => {
  deleteVectors.mockClear();
  vectorStoreSpy = spyOn(vectorStores, "getActiveVectorStore").mockResolvedValue(stubVectorStore({ deleteByFilter: deleteVectors }));
  closeDatabase(); initDatabase(":memory:");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  for (const id of [OWNER, OTHER]) getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').run(id, id, `${id}@example.com`);
  originalDataDir = env.dataDir; workDir = mkdtempSync(join(tmpdir(), "lumiverse-cl-test-")); env.dataDir = workDir;
});
afterEach(async () => {
  try {
    await waitForClMigrations();
  } finally {
    vectorStoreSpy.mockRestore();
    closeDatabase();
    env.dataDir = originalDataDir;
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("CharacterLibrary migration", () => {
  test("imports distinct identities, shared gallery ownership, real lore links, regex and chat data", async () => {
    const preview = await stage();
    expect(preview.counts).toEqual({ characters: 2, worlds: 2, chats: 1, galleryFiles: 1 });
    const report = await execute(preview.jobId);
    expect(report.status).toBe("completed"); expect(report.totals.failed).toBe(0);
    const a = destination(report, "character", "cards/a.png"), b = destination(report, "character", "cards/b.png");
    expect(a).not.toBe(b); expect(count("characters")).toBe(2);
    const primary = destination(report, "world", "world-file"), aux = destination(report, "world", "aux-file");
    expect(primary).not.toBe(aux);
    const character = getCharacter(OWNER, a)!;
    expect(character.library_scope).toBe("mine"); expect(character.extensions.world_book_ids).toEqual([primary, aux]);
    expect(character.extensions.custom).toEqual({ untouched: true });
    expect(character.description).toBe(`![Scene](gallery://image-1) ${local}.backup https://example.com${local}`);
    expect(character.alternate_greetings).toEqual(["Again gallery://image-1"]);
    expect(character.created_at).toBe(Date.parse("2024-01-01T00:00:00.000Z") / 1000);
    const ga = listGallery(OWNER, a)[0]!, gb = listGallery(OWNER, b)[0]!;
    expect(ga.image_id).toBe(gb.image_id); expect(getImage(OWNER, ga.image_id)!.owner_character_id).toBeNull();
    expect(getImage(OWNER, character.image_id!)!.owner_character_id).toBe(a);
    const scripts = getRegexScriptsByCharacterId(OWNER, a);
    expect(scripts).toHaveLength(2); expect(scripts.every((r) => r.disabled)).toBe(true);
    expect(scripts.find((r) => r.name === "Scene")!.replace_string).toBe("![Scene](gallery://image-1)");
    const chatId = destination(report, "chat", "chats/a/First.jsonl"), chat = getChat(OWNER, chatId)!;
    expect(chat.metadata.chat_world_book_ids).toEqual([aux]); expect(chat.metadata.custom_note).toBe("kept"); expect(chat.metadata.persona_id).toBeUndefined();
    const messages = getMessages(OWNER, chatId);
    expect(messages).toHaveLength(2); expect(messages[1]!.content).toContain("gallery://image-1");
    expect(messages[1]!.swipes).toEqual(["First", "Second gallery://image-1"]); expect(messages[1]!.extra.custom).toBe("message");
    expect(getSetting(OWNER, "favorites")!.value).toEqual([a]);
    expect(report.issues.some((r) => r.code === "v1_inventory")).toBe(true);
    expect(getCharacter(OTHER, a)).toBeNull(); expect(clMigrationArchivePath(OTHER, preview.jobId)).toBeNull();
    expect(await clFileSha256(clMigrationArchivePath(OWNER, preview.jobId)!)).toBe(preview.archiveSha256);
  });

  test("reruns reuse completed items and preserve edits and regex decisions", async () => {
    const preview = await stage(), first = await execute(preview.jobId);
    const id = destination(first, "character", "cards/a.png");
    updateCharacter(OWNER, id, { description: "User edit" });
    putSetting(OWNER, "favorites", []);
    const totals = [count("characters"), count("world_books"), count("images"), count("regex_scripts"), count("chats"), count("character_gallery")];
    const second = await execute(preview.jobId, OWNER, { enableRegex: true });
    expect(second.status).toBe("completed"); expect(second.totals.imported).toBe(0); expect(second.totals.reused).toBe(first.totals.imported);
    expect(getCharacter(OWNER, id)!.description).toBe("User edit");
    expect(getSetting(OWNER, "favorites")!.value).toEqual([]);
    expect(getRegexScriptsByCharacterId(OWNER, id).every((r) => r.disabled)).toBe(true);
    expect([count("characters"), count("world_books"), count("images"), count("regex_scripts"), count("chats"), count("character_gallery")]).toEqual(totals);
  });

  test("explicit regex opt-in enables supported scripts only", async () => {
    const preview = await stage(), report = await execute(preview.jobId, OWNER, { enableRegex: true });
    const scripts = getRegexScriptsByCharacterId(OWNER, destination(report, "character", "cards/a.png"));
    expect(scripts.find((r) => r.name === "Scene")!.disabled).toBe(false);
    expect(scripts.find((r) => r.name === "Deprecated")!.disabled).toBe(true);
  });

  test("source namespaces and accounts isolate copies, while stable identities reject changed bytes", async () => {
    const p = await stage(fixture(), OWNER, "installation-one"), first = await execute(p.jobId);
    const changed = await stage(fixture("Changed source"), OWNER, "installation-one"), conflict = await execute(changed.jobId);
    expect(conflict.status).toBe("partial"); expect(conflict.items.some((r) => r.source === "cards/a.png" && r.message?.includes("Source content changed"))).toBe(true);
    expect(count("characters")).toBe(2);
    const separate = await stage(fixture(), OWNER, "installation-two"); expect((await execute(separate.jobId)).status).toBe("completed");
    const other = await stage(fixture(), OTHER, "installation-one"), otherReport = await execute(other.jobId, OTHER);
    expect(otherReport.status).toBe("completed"); expect(count("characters")).toBe(6);
    expect(destination(first, "character", "cards/a.png")).not.toBe(destination(otherReport, "character", "cards/a.png"));
  });

  test("reports missing media and invalid chats without guessing lost messages", async () => {
    const files = fixture(); delete files["gallery/shared/scene.png"];
    files["chats/a/First.jsonl"] = strToU8('{"user_name":"You"}\nthis is invalid JSON\n');
    const preview = await stage(files); expect(preview.issues.some((i) => i.code === "missing_file")).toBe(true);
    const report = await execute(preview.jobId); expect(report.status).toBe("partial"); expect(count("chats")).toBe(0);
    expect(report.items.some((r) => r.kind === "chat" && r.status === "failed")).toBe(true);
    expect(clMigrationArchivePath(OWNER, preview.jobId)).not.toBeNull();
  });

  test("repairs a missing avatar file without duplicating characters", async () => {
    const preview = await stage(), first = await execute(preview.jobId), id = destination(first, "character", "cards/a.png");
    const originalAvatar = getCharacter(OWNER, id)!.image_id!;
    rmSync(join(env.dataDir, "images", getImage(OWNER, originalAvatar)!.filename));
    const second = await execute(preview.jobId);
    expect(second.status).toBe("completed"); expect(count("characters")).toBe(2);
    expect(getCharacter(OWNER, id)!.image_id).not.toBe(originalAvatar);
    expect(existsSync(join(env.dataDir, "images", getImage(OWNER, getCharacter(OWNER, id)!.image_id!)!.filename))).toBe(true);
  });

  test("rebuilds unreceipted interrupted books while preserving unrelated books", async () => {
    const p = await stage();
    const partial = createWorldBook(OWNER, { name: "Interrupted", metadata: { character_library: { sourceId: p.sourceId, sourceKey: "world-file", attemptId: "interrupted-attempt" } } });
    const unrelated = createWorldBook(OWNER, { name: "Same Book Name" });
    const report = await execute(p.jobId);
    expect(report.status).toBe("completed");
    expect(getDb().query("SELECT id FROM world_books WHERE id = ?").get(partial.id)).toBeNull();
    expect(getDb().query("SELECT id FROM world_books WHERE id = ?").get(unrelated.id)).not.toBeNull();
    expect(count("world_books")).toBe(5);
    expect(deleteVectors).toHaveBeenCalledWith("embeddings_world_books", {
      op: "and",
      clauses: [
        { op: "eq", field: "user_id", value: OWNER },
        { op: "eq", field: "source_type", value: "world_book_entry" },
        { op: "in", field: "owner_id", values: [partial.id] },
      ],
    });
  });

  test("cleans up a failed chunked world-book import", async () => {
    const files = fixture(); files["worlds/0.json"] = strToU8(JSON.stringify({ name: "Invalid entries", entries: [null] }));
    const p = await stage(files), report = await execute(p.jobId);
    expect(report.status).toBe("partial"); expect(count("world_books")).toBe(3);
    expect(report.items.some((r) => r.kind === "world" && r.source === "world-file" && r.status === "failed")).toBe(true);
  });

  test("reports conflicting PNG metadata and preserves both source payloads", async () => {
    const files = fixture();
    files["cards/a.png"] = embedPngTextChunk(Buffer.from(files["cards/a.png"]!), "chara", Buffer.from(JSON.stringify({ name: "V2 choice" })).toString("base64"));
    const p = await stage(files), report = await execute(p.jobId);
    expect(report.status).toBe("completed"); expect(report.issues.some((i) => i.code === "png_payloads_differ")).toBe(true);
    expect(getCharacter(OWNER, destination(report, "character", "cards/a.png"))!.name).toBe("V2 choice");
  });

  test("deleting staging removes raw sources but preserves imported data and retry receipts", async () => {
    const p = await stage(), first = await execute(p.jobId);
    expect(deleteClMigrationJob(OTHER, p.jobId)).toBe(false);
    expect(deleteClMigrationJob(OWNER, p.jobId)).toBe(true); expect(clMigrationArchivePath(OWNER, p.jobId)).toBeNull();
    expect(count("characters")).toBe(2);
    const again = await stage(); expect((await execute(again.jobId)).totals.reused).toBe(first.totals.imported);
  });

  test("accepts identical shared gallery ZIP entries and rejects conflicting duplicates", async () => {
    const entries = Object.entries(fixture());
    const duplicate = storedZip([...entries, ["gallery/shared/scene.png", png]]);
    const p = await stageClMigrationBundle({ userId: OWNER, body: body(duplicate), declaredSize: duplicate.length });
    expect((await execute(p.jobId)).status).toBe("completed"); expect(count("character_gallery")).toBe(2);
    const bad = storedZip([...entries, ["gallery/shared/scene.png", new Uint8Array([1, 2, 3])]]);
    await expect(stageClMigrationBundle({ userId: OWNER, body: body(bad), declaredSize: bad.length })).rejects.toThrow("different data");
    const duplicateCard = storedZip([...entries, ["cards/a.png", card()]]);
    await expect(stageClMigrationBundle({ userId: OWNER, body: body(duplicateCard), declaredSize: duplicateCard.length })).rejects.toThrow("duplicate entry");
  });

  test("rejects unsafe archive paths and source identities before importing", async () => {
    for (const path of ["../evil", "/evil", "C:/evil", "a\\b", "a/./b", "a//b", "a/../b"]) expect(() => safeClArchivePath(path)).toThrow(ArchiveValidationError);
    const raw = JSON.parse(new TextDecoder().decode(fixture()["manifest.json"]!));
    raw.characters[1].avatar = "a.png"; expect(() => validateClManifest(raw)).toThrow("Duplicate character identity");
    const files = fixture(); files["../evil.txt"] = strToU8("bad");
    await expect(stage(files)).rejects.toThrow("unsafe archive path");
    await expect(stage(fixture(), OWNER, "../other")).rejects.toThrow(ClMigrationError);
    expect(count("cl_migration_jobs")).toBe(0);
  });

  test("authenticated routes scope jobs and downloads and reject target-user overrides", async () => {
    const app = authenticatedApp();
    expect((await app.request("/api/v1/cl-migration/jobs")).status).toBe(401);
    const p = await stage(), headers = { Cookie: "test-session=valid" };
    const other = authenticatedApp(OTHER);
    for (const suffix of ["", "/source"]) expect((await other.request(`/api/v1/cl-migration/jobs/${p.jobId}${suffix}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/v1/cl-migration/jobs/${p.jobId}/execute`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ targetUserId: OTHER }) })).status).toBe(400);
    expect((await app.request(`/api/v1/cl-migration/jobs/${p.jobId}/source`, { headers })).status).toBe(200);
    expect((await app.request(`/api/v1/cl-migration/jobs/${p.jobId}/execute`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status).toBe(202);
    expect(() => deleteClMigrationJob(OWNER, p.jobId)).toThrow("running migration");
    await waitForClMigrations();
  });

  test("CLI uploads, polls, writes a report and supports a preflight without native writes", async () => {
    const app = authenticatedApp();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const path = join(workDir, "fixture.zip"), reportPath = join(workDir, "report.json"); await Bun.write(path, zipSync(fixture()));
      const run = async (...args: string[]) => {
        const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../../scripts/migrate-character-library.ts"), "--url", `http://127.0.0.1:${server.port}`, "--bundle", path, ...args], { env: { ...process.env, LUMIVERSE_MIGRATION_COOKIE: "test-session=valid" }, stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        return { code, stdout, stderr };
      };
      const preflight = await run("--dry-run", "--report", reportPath);
      expect(preflight.code).toBe(0); expect(preflight.stdout).toContain("staging discarded"); expect(count("characters")).toBe(0); expect(count("cl_migration_jobs")).toBe(0);
      expect((await Bun.file(reportPath).json()).counts.characters).toBe(2);
      const completed = await run("--yes", "--report", reportPath);
      expect(completed.code).toBe(0); expect(completed.stdout).toContain("Migration completed"); expect(completed.stderr).toBe(""); expect(count("characters")).toBe(2);
      expect((await Bun.file(reportPath).json()).status).toBe("completed");
    } finally { await server.stop(true); }
  }, 15000);
});
