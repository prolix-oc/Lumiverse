import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { isChatMemoryVectorizationEnabled } from "./embeddings.service";
import { getSetting, putSetting } from "./settings.service";
import * as secrets from "./secrets.service";

const owner = "memory-enablement-owner", member = "memory-enablement-member";
beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  db.query(`INSERT INTO "user" (id, name, email, emailVerified, createdAt)
    VALUES (?, 'Owner', 'enable-owner@example.test', 1, 1), (?, 'Member', 'enable-member@example.test', 1, 2)`)
    .run(owner, member);
});
afterEach(() => closeDatabase());

test("missing settings disable chat vectorization without creating a config row", () => {
  expect(isChatMemoryVectorizationEnabled(owner)).toBe(false);
  expect(getSetting(owner, "embeddingConfig")).toBeNull();
});

test.each([[false, false], [false, true], [true, false], [true, true]])(
  "requires both embeddings=%s and chat vectorization=%s", (enabled, vectorize_chat_messages) => {
    putSetting(owner, "embeddingConfig", { enabled, vectorize_chat_messages });
    expect(isChatMemoryVectorizationEnabled(owner)).toBe(enabled && vectorize_chat_messages);
  },
);

test("uses the owner's effective vectorization flag while inheritance is active", () => {
  putSetting(owner, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
  putSetting(member, "embeddingConfig", { enabled: true, vectorize_chat_messages: false });
  expect(isChatMemoryVectorizationEnabled(member)).toBe(true);
  putSetting(owner, "embeddingConfig", { enabled: true, vectorize_chat_messages: false });
  putSetting(member, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
  expect(isChatMemoryVectorizationEnabled(member)).toBe(false);
  putSetting(owner, "embeddingConfig", { enabled: false, vectorize_chat_messages: false });
  expect(isChatMemoryVectorizationEnabled(member)).toBe(true);
});

test("reads setting changes immediately without credential lookup or config migration", () => {
  const status = spyOn(secrets, "getSecretForStatus").mockRejectedValue(new Error("Must not resolve credentials"));
  try {
    const config = { enabled: true, vectorize_chat_messages: true };
    putSetting(owner, "embeddingConfig", config);
    expect(isChatMemoryVectorizationEnabled(owner)).toBe(true);
    expect(getSetting(owner, "embeddingConfig")!.value).toEqual(config);
    putSetting(owner, "embeddingConfig", { ...config, vectorize_chat_messages: false });
    expect(isChatMemoryVectorizationEnabled(owner)).toBe(false);
    expect(status).not.toHaveBeenCalled();
  } finally { status.mockRestore(); }
});
