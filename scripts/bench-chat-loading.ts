/**
 * Synthetic chat-open SQL audit. No server, credentials, or live data required.
 * Run: bun --no-env-file scripts/bench-chat-loading.ts [message-count]
 * Uses the real chat routes with fixture authentication and an in-memory DB.
 * Timings exclude HTTP transport, requireAuth, compression, and production DB IPC.
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { chatsRoutes } from "../src/routes/chats.routes";
import { listMessagesTail } from "../src/services/chats.service";
import type {} from "../src/auth/middleware";

const messageCount = Number(process.argv[2] ?? 50_000);
assert(Number.isInteger(messageCount) && messageCount >= 100 && messageCount <= 100_000,
  "message-count must be an integer between 100 and 100000");

async function main() {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../src/db/baseline.sql", import.meta.url)).text());
  db.query("INSERT INTO user(id,name,email,role) VALUES('audit','Audit','audit@example.invalid','owner')").run();
  db.query("INSERT INTO characters(id,user_id,name) VALUES('char','audit','Audit Character')").run();
  db.query("INSERT INTO personas(id,user_id,name,is_default) VALUES('persona','audit','Audit Persona',1)").run();
  db.query("INSERT INTO chats(id,user_id,character_id,name) VALUES('chat','audit','char','Audit Chat')").run();
  const insert = db.query(`INSERT INTO messages
    (id,chat_id,index_in_chat,is_user,name,content,swipes,extra) VALUES(?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < messageCount; i++) {
      const content = `Synthetic message ${i} ` + "Lorem ipsum dolor sit amet. ".repeat(12);
      insert.run(`m${i}`, "chat", i, i % 2, "Audit", content,
        JSON.stringify([content, content + " alternate", content + " another alternate"]), "{}");
    }
  })();

  // Count executions, including cached statements and the async read helper's
  // prepare() path. Instrument only this disposable connection, once per handle.
  let executed: string[] = [];
  let counting = true;
  const wrapped = new WeakSet<object>();
  const originalQuery = db.query.bind(db);
  const originalPrepare = db.prepare.bind(db);
  function instrument(statement: ReturnType<Database["query"]>, sql: string) {
    if (!wrapped.has(statement)) {
      wrapped.add(statement);
      for (const method of ["get", "all", "values", "run"] as const) {
        const original = statement[method].bind(statement);
        Object.defineProperty(statement, method, {
          configurable: true, enumerable: true, writable: true,
          value: (...args: any[]) => {
            if (counting) executed.push(sql);
            return original(...args);
          },
        });
      }
    }
    return statement;
  }
  db.query = ((...args: Parameters<Database["query"]>) =>
    instrument(originalQuery(...args), args[0])) as Database["query"];
  db.prepare = ((...args: Parameters<Database["prepare"]>) =>
    instrument(originalPrepare(...args), args[0])) as Database["prepare"];

  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "audit"); await next(); });
  app.route("/chats", chatsRoutes);
  function log(value: unknown) { console.log(JSON.stringify(value)); }
  log({ fixture: { messageCount, swipesPerMessage: 3, database: ":memory:", bun: Bun.version } });

  for (const [label, rawContent, expected] of [
    ["plain", "Plain text without macros", "Plain text without macros"],
    ["identity macros", "Hello {{char}} and {{user}}", "Hello Audit Character and Audit Persona"],
    ["outlet without attached books", "Lore: {{outlet::lore}}", "Lore: "],
  ]) {
    executed = [];
    const started = performance.now();
    const response = await app.request("/chats/chat/display-preprocess", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({
        messageId: `m${i}`, messageIndex: i, role: i % 2 ? "user" : "assistant", rawContent,
      })) }),
    });
    assert.equal(response.status, 200);
    const json = await response.json() as { items: Array<{ content: string }> };
    assert.equal(json.items.length, 50);
    assert(json.items.every(item => item.content === expected));
    const grouped = new Map<string, number>();
    for (const sql of executed) grouped.set(sql, (grouped.get(sql) ?? 0) + 1);
    log({ label, items: 50, queries: executed.length,
      ms: +(performance.now() - started).toFixed(3), sql: [...grouped] });
  }

  for (const [label, url] of [
    ["metadata", "/chats/chat?messages=false"],
    ["tail", "/chats/chat/messages?limit=50&tail=true"],
    ["open", "/chats/chat/open?limit=50"],
    ["cursor", `/chats/chat/messages?limit=50&beforeIndex=${messageCount - 50}&beforeId=m${messageCount - 50}`],
    ["offset", `/chats/chat/messages?limit=50&offset=${messageCount - 100}`],
  ]) {
    executed = [];
    const started = performance.now();
    const response = await app.request(url);
    assert.equal(response.status, 200);
    const body = await response.text();
    log({ label, queries: executed.length, bytes: Buffer.byteLength(body),
      ms: +(performance.now() - started).toFixed(3), sql: executed });
  }

  // Raw SQL comparison: same 50 rows, same schema, existing indexes only.
  const countSql = "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id=c.id WHERE m.chat_id=? AND c.user_id=?";
  const offsetSql = "SELECT m.* FROM messages m JOIN chats c ON m.chat_id=c.id WHERE m.chat_id=? AND c.user_id=? ORDER BY m.index_in_chat ASC LIMIT ? OFFSET ?";
  const cursorSql = "SELECT m.* FROM messages m JOIN chats c ON m.chat_id=c.id WHERE m.chat_id=? AND c.user_id=? AND m.index_in_chat <= ? AND (m.index_in_chat < ? OR m.id < ?) ORDER BY m.index_in_chat DESC, m.id DESC LIMIT ?";
  const count = originalQuery(countSql), offset = originalQuery(offsetSql), cursor = originalQuery(cursorSql);
  assert.deepEqual(
    (offset.all("chat", "audit", 50, messageCount - 100) as { id: string }[]).map(row => row.id),
    (cursor.all("chat", "audit", messageCount - 50, messageCount - 50, `m${messageCount - 50}`, 50) as { id: string }[]).reverse().map(row => row.id),
  );
  log({ plans: {
    count: originalQuery("EXPLAIN QUERY PLAN " + countSql).all("chat", "audit"),
    offset: originalQuery("EXPLAIN QUERY PLAN " + offsetSql).all("chat", "audit", 50, messageCount - 100),
    cursor: originalQuery("EXPLAIN QUERY PLAN " + cursorSql).all("chat", "audit", messageCount - 50, messageCount - 50, `m${messageCount - 50}`, 50),
  } });
  // Disable counters for timing so instrumentation cannot grow the sample log.
  counting = false;
  db.query = originalQuery as Database["query"];
  db.prepare = originalPrepare as Database["prepare"];
  function measure(label: string, run: () => unknown) {
    for (let i = 0; i < 10; i++) run();
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now(); run(); samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    log({ label, p50ms: +samples[50].toFixed(4), p95ms: +samples[95].toFixed(4) });
  }
  measure("count", () => count.get("chat", "audit"));
  measure("offset limit 50", () => offset.all("chat", "audit", 50, messageCount - 100));
  measure("cursor limit 50", () => cursor.all("chat", "audit", messageCount - 50, messageCount - 50, `m${messageCount - 50}`, 50));
  // Cached service statements retain a wrapper; counters are disabled above.
  measure("light tail 50 including count and hydration", () => listMessagesTail("audit", "chat", 50, { light: true }));
}

try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally {
  closeDatabase();
  // Imported runtime modules own housekeeping timers; this is a standalone CLI.
  process.exit(process.exitCode ?? 0);
}
