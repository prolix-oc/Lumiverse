import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  connectionTargetForSecret,
  markConnectionSecretRestored,
} from "./connection-secret-restore";

const USER_ID = "user-importing";
const OTHER_USER_ID = "user-other";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  for (const table of [
    "connection_profiles",
    "image_gen_connections",
    "tts_connections",
    "stt_connections",
  ]) {
    getDb().run(`CREATE TABLE ${table} (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      has_api_key INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, user_id)
    )`);
  }
});

afterEach(() => closeDatabase());

describe("restored connection secrets", () => {
  test("recognizes every connection API-key namespace", () => {
    expect(connectionTargetForSecret("connection_openrouter-id_api_key")).toEqual({
      table: "connection_profiles",
      id: "openrouter-id",
    });
    expect(connectionTargetForSecret("image_gen_connection_image-id_api_key")).toEqual({
      table: "image_gen_connections",
      id: "image-id",
    });
    expect(connectionTargetForSecret("tts_connection_tts-id_api_key")).toEqual({
      table: "tts_connections",
      id: "tts-id",
    });
    expect(connectionTargetForSecret("stt_connection_stt-id_api_key")).toEqual({
      table: "stt_connections",
      id: "stt-id",
    });
    expect(connectionTargetForSecret("embedding_api_key_openrouter")).toBeNull();
  });

  test("marks an imported OpenRouter connection as having its restored key", () => {
    getDb().query(
      "INSERT INTO connection_profiles (id, user_id, has_api_key) VALUES (?, ?, 0)",
    ).run("openrouter-id", USER_ID);

    expect(markConnectionSecretRestored(USER_ID, "connection_openrouter-id_api_key")).toBe(true);
    expect(getDb().query(
      "SELECT has_api_key FROM connection_profiles WHERE id = ? AND user_id = ?",
    ).get("openrouter-id", USER_ID)).toEqual({ has_api_key: 1 });
  });

  test("does not alter a same-id connection owned by another user", () => {
    getDb().query(
      "INSERT INTO connection_profiles (id, user_id, has_api_key) VALUES (?, ?, 0)",
    ).run("shared-id", OTHER_USER_ID);

    expect(markConnectionSecretRestored(USER_ID, "connection_shared-id_api_key")).toBe(false);
    expect(getDb().query(
      "SELECT has_api_key FROM connection_profiles WHERE id = ? AND user_id = ?",
    ).get("shared-id", OTHER_USER_ID)).toEqual({ has_api_key: 0 });
  });
});
