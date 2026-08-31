import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_AUDIO_BYTES, getAudio, getAudioFilePath, saveAudio } from "./audio.service";

const originalDataDir = env.dataDir;
let testDataDir = "";

function initAudioTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE audio_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  )`);
}

beforeEach(() => {
  initAudioTestDb();
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-audio-test-"));
  env.dataDir = testDataDir;
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
  testDataDir = "";
});

describe("audio.service persistence boundary", () => {
  test("validates bytes before writing and stores detected MIME/extension", async () => {
    const payload = Uint8Array.from([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    const audio = await saveAudio("user-1", {
      data: payload,
      mime_type: "text/plain",
      original_filename: "voice.txt",
      duration_ms: 1250,
    });

    expect(audio.user_id).toBe("user-1");
    expect(audio.mime_type).toBe("audio/mpeg");
    expect(audio.filename).toMatch(/\.mp3$/);
    expect(audio.original_filename).toBe("voice.txt");
    expect(audio.size_bytes).toBe(payload.byteLength);
    expect(audio.duration_ms).toBe(1250);
    const path = getAudioFilePath("user-1", audio.id);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!)).toEqual(Buffer.from(payload));
    expect(getAudio("other-user", audio.id)).toBeNull();
  });

  test("rejects invalid or oversized payloads before creating a row", async () => {
    await expect(saveAudio("user-1", {
      data: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
      mime_type: "audio/mpeg",
    })).rejects.toThrow("Unsupported or invalid audio payload");
    expect(getDb().query("SELECT COUNT(*) AS count FROM audio_files").get()).toEqual({ count: 0 });

    const oversized = new Uint8Array(MAX_AUDIO_BYTES + 1);
    await expect(saveAudio("user-1", {
      data: oversized,
      mime_type: "audio/mpeg",
    })).rejects.toThrow("Audio payload must be between");
    expect(getDb().query("SELECT COUNT(*) AS count FROM audio_files").get()).toEqual({ count: 0 });
  });
});
