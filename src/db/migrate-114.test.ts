import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const MIGRATION_PATH = `${import.meta.dir}/migrations/114_cleanup_stale_message_breakdowns.sql`;

function createLegacyDatabase(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE message_breakdowns (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT,
    data TEXT NOT NULL
  )`);
  return db;
}

describe("114 stale message-breakdown cleanup", () => {
  test("removes historical deletion leaks while preserving valid snapshots", async () => {
    const db = createLegacyDatabase();
    try {
      db.run(`
        INSERT INTO chats (id, user_id) VALUES
          ('gap-chat', 'u1'),
          ('valid-chat', 'u1');

        -- gap-chat previously lost index 1. The live index-2 breakdown can
        -- still contain that deleted user message in its prompt history.
        INSERT INTO messages (id, chat_id, index_in_chat) VALUES
          ('before-gap', 'gap-chat', 0),
          ('after-gap', 'gap-chat', 2),
          ('valid-zero', 'valid-chat', 0),
          ('valid-one', 'valid-chat', 1);

        INSERT INTO message_breakdowns (message_id, chat_id, user_id, data) VALUES
          ('before-gap', 'gap-chat', 'u1', '{"marker":"safe-earlier"}'),
          ('deleted-message', 'gap-chat', 'u1', '{"marker":"direct-leak"}'),
          ('after-gap', 'gap-chat', 'u1', '{"marker":"embedded-leak"}'),
          ('deleted-chat-message', 'deleted-chat', 'u1', '{"marker":"deleted-chat-leak"}'),
          ('valid-zero', 'valid-chat', 'u1', '{"marker":"keep-zero"}'),
          ('valid-one', 'valid-chat', 'u1', '{"marker":"keep-one"}');
      `);

      db.run(await Bun.file(MIGRATION_PATH).text());

      expect(
        db.query("SELECT message_id FROM message_breakdowns ORDER BY message_id").all(),
      ).toEqual([
        { message_id: "before-gap" },
        { message_id: "valid-one" },
        { message_id: "valid-zero" },
      ]);
    } finally {
      db.close();
    }
  });
});
