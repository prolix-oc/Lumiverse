import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { chatsRoutes } from "./chats.routes";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { captureMessageLiterals, withMessageLiteralExtra } from "../macros/message-literals";
import * as worldBooks from "../services/world-books.service";
import type {} from "../auth/middleware";

const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
app.route("/chats", chatsRoutes);

function insertMessage(id: string, index: number, chatId = "chat", extra = {}) {
  getDb().query(`INSERT INTO messages(id,chat_id,index_in_chat,name,content,swipes,swipe_dates,extra)
    VALUES(?,?,?,'Character',?,?,'[1,2]',?)`).run(id, chatId, index, id, JSON.stringify([id, "alternate"]), JSON.stringify(extra));
}

/** Count executions, including already-prepared statements and async reads. */
function countSql() {
  const db = getDb(), executed: string[] = [], seen = new WeakSet<object>();
  for (const method of ["query", "prepare"] as const) {
    const original = db[method].bind(db);
    db[method] = ((sql: string, ...args: any[]) => {
      const statement = original(sql, ...args);
      if (!seen.has(statement)) {
        seen.add(statement);
        for (const operation of ["get", "all", "values", "run"] as const) {
          const read = statement[operation].bind(statement);
          Object.defineProperty(statement, operation, { configurable: true, value: (...bindings: any[]) => {
            executed.push(sql); return read(...bindings);
          } });
        }
      }
      return statement;
    }) as typeof db[typeof method];
  }
  return executed;
}

async function preprocess(items: Record<string, unknown>[]) {
  const response = await app.request("/chats/chat/display-preprocess", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).items as Array<{ content: string; incrementalRawAppendSafe: boolean }>;
}

beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  db.query("INSERT INTO characters(id,user_id,name) VALUES('character','owner','Fresh Character'),('foreign','other','Private')").run();
  db.query("INSERT INTO chats(id,user_id,character_id,metadata) VALUES('chat','owner','character','{}'),('other-chat','other','foreign','{}'),('second-chat','owner','character','{}')").run();
  for (let i = 0; i < 10; i++) insertMessage(`m${i}`, i);
  insertMessage("foreign-message", 0, "other-chat");
  insertMessage("second-message", 0, "second-chat");
});
afterEach(closeDatabase);

describe("chat open and cursor history", () => {
  test("one bounded open returns fresh group members and light swipes, keeping legacy routes", async () => {
    const db = getDb();
    db.query("INSERT INTO characters(id,user_id,name) VALUES('member','owner','Fresh Member')").run();
    db.query("UPDATE chats SET metadata=? WHERE id='chat'").run(JSON.stringify({ group: true, character_ids: ["character", "member", "foreign"] }));
    const response = await app.request("/chats/chat/open?limit=3");
    expect(response.status).toBe(200);
    const opened = await response.json();
    expect(opened.characters.map((character: any) => character.name).sort()).toEqual(["Fresh Character", "Fresh Member"]);
    expect(opened.messages.total).toBe(10);
    expect(opened.messages.data.map((message: any) => message.id)).toEqual(["m7", "m8", "m9"]);
    expect(opened.messages.data[0].swipes).toEqual(["m7", null]);
    expect(opened.chat.character_display_owner).toBeNull();
    expect((await (await app.request("/chats/chat?messages=false")).json()).messages).toBeUndefined();
    expect((await (await app.request("/chats/chat/messages?limit=2&offset=1")).json()).total).toBe(10);
  });

  test("paging remains gap-free after append/delete, supports tied positions and a deleted boundary", async () => {
    const db = getDb();
    db.query("UPDATE messages SET index_in_chat=6 WHERE id='m5'").run();
    insertMessage("new-tail", 11);
    db.query("DELETE FROM messages WHERE id IN ('m9','m7')").run();
    const sql = countSql();
    const page = await (await app.request("/chats/chat/messages?limit=3&beforeIndex=7&beforeId=m7")).json();
    expect(page.data.map((message: any) => message.id)).toEqual(["m4", "m5", "m6"]);
    expect(page.has_more).toBe(true);
    expect(sql.some((query) => query.includes("COUNT("))).toBe(false);
    const next = await (await app.request("/chats/chat/messages?limit=9&beforeIndex=4&beforeId=m4")).json();
    expect(next.data.map((message: any) => message.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(next.has_more).toBe(false);
  });

  test("boundaries are validated and all reads stay owner scoped", async () => {
    for (const path of ["open", "messages?beforeIndex=5&beforeId=m5"]) {
      expect((await app.request(`/chats/other-chat/${path}`)).status).toBe(404);
      expect((await app.request(`/chats/missing/${path}`)).status).toBe(404);
    }
    for (const query of ["beforeIndex=-1&beforeId=m1", "beforeIndex=no&beforeId=m1", "beforeIndex=2"]) {
      expect((await app.request(`/chats/chat/messages?${query}`)).status).toBe(400);
    }
  });
});

describe("request-scoped display reads", () => {
  test("fifty identity/outlet bodies share source and context reads without reading history", async () => {
    const sql = countSql();
    const items = await preprocess(Array.from({ length: 50 }, (_, i) => ({
      messageId: `m${i % 10}`, rawContent: "{{char}}/{{outlet::empty}}", role: "assistant",
    })));
    expect(items.every((item) => item.content === "Fresh Character/" && item.incrementalRawAppendSafe)).toBe(true);
    expect(sql.filter((query) => query.includes("m.id IN"))).toHaveLength(1);
    expect(sql.filter((query) => query.includes("SELECT * FROM chats"))).toHaveLength(2);
    expect(sql.some((query) => query.includes("ORDER BY m.index_in_chat ASC"))).toBe(false);
  });

  test("stored swipe presets and local mutations cannot bleed into another item or another request", async () => {
    const db = getDb();
    db.query("INSERT INTO presets(id,user_id,name,provider) VALUES('preset','owner','Preset','loom')").run();
    const contexts = ["A", "B"].map((mode) => ({ preset_id: "preset", variables: { local: { mode } } }));
    db.query("UPDATE messages SET extra=? WHERE id='m0'").run(JSON.stringify({ spindle_metadata: { preset_contexts: contexts } }));
    const sql = countSql();
    const items = await preprocess([
      { messageId: "m0", swipeIndex: 0, rawContent: "{{setvar::leak::yes}}{{var::mode}}" },
      { messageId: "m0", swipeIndex: 1, rawContent: "{{var::mode}}/{{getvar::leak}}" },
      { messageId: "m1", rawContent: "{{getvar::leak}}" },
    ]);
    expect(items.map((item) => item.content)).toEqual(["A", "B/", ""]);
    expect(sql.filter((query) => query.includes("SELECT * FROM presets"))).toHaveLength(1);
    db.query("UPDATE characters SET name='Changed' WHERE id='character'").run();
    expect((await preprocess([{ rawContent: "{{char}}" }]))[0].content).toBe("Changed");
  });

  test("literal macros/JSON stay inert and another chat's stored context is not used", async () => {
    const raw = "{{setchatvar::owned::yes}}";
    const extra = withMessageLiteralExtra({}, { content: raw, literalBraces: [...raw.matchAll(/[{}]/g)].map((match) => match.index!) });
    getDb().query("UPDATE messages SET extra=? WHERE id IN ('m0','second-message','foreign-message')").run(JSON.stringify(extra));
    const result = await preprocess([
      { messageId: "m0", rawContent: raw },
      { messageId: "m1", rawContent: `<json>${JSON.stringify({ literal: raw })}</json>` },
      { messageId: "second-message", rawContent: raw },
      { messageId: "foreign-message", rawContent: raw },
    ]);
    expect(captureMessageLiterals(result[0].content).content).toBe(raw);
    expect(result[1].content).toContain(raw);
    expect(result[2].content).toBe("");
    expect(result[3].content).toBe("");
  });

  test("attached outlets read history once but render separately with each swipe's variables", async () => {
    const book = worldBooks.createWorldBook("owner", { name: "Outlets" });
    worldBooks.createEntry("owner", book.id, { constant: true, key: [], content: "{{var::mode}}", outlet_name: "mode" });
    const db = getDb();
    db.query("UPDATE chats SET metadata=? WHERE id='chat'").run(JSON.stringify({ chat_world_book_ids: [book.id] }));
    db.query("INSERT INTO presets(id,user_id,name,provider) VALUES('preset','owner','Preset','loom')").run();
    db.query("UPDATE messages SET extra=? WHERE id='m0'").run(JSON.stringify({ spindle_metadata: { preset_contexts:
      ["A", "B"].map((mode) => ({ preset_id: "preset", variables: { local: { mode } } })) } }));
    const sql = countSql();
    const result = await preprocess([0, 1].map((swipeIndex) => ({ messageId: "m0", swipeIndex, rawContent: "{{outlet::mode}}" })));
    expect(result.map((item) => item.content)).toEqual(["A", "B"]);
    expect(sql.filter((query) => query.includes("ORDER BY m.index_in_chat ASC"))).toHaveLength(1);
  });

  test("extension processors still run per item before macro evaluation", async () => {
    const seen: string[] = [];
    const unregister = messageContentProcessorChain.register({
      extensionId: "loading-test", userId: "owner", priority: 1,
      handler: async (context) => { seen.push(context.messageId!); return { content: `${context.content} {{char}}` }; },
    });
    try {
      const result = await preprocess(["m0", "m1"].map((messageId) => ({ messageId, rawContent: messageId })));
      expect(seen).toEqual(["m0", "m1"]);
      expect(result.map((item) => item.content)).toEqual(["m0 Fresh Character", "m1 Fresh Character"]);
      expect(result.every((item) => !item.incrementalRawAppendSafe)).toBe(true);
    } finally { unregister(); }
  });

  test("processor edits to a later item's source remain visible within the batch", async () => {
    const content = "{{char}}";
    const extra = withMessageLiteralExtra({}, { content, literalBraces: [0, 1, 6, 7] });
    const unregister = messageContentProcessorChain.register({
      extensionId: "loading-mutation-test", userId: "owner", priority: 1,
      handler: async (context) => {
        if (context.messageId === "m0") getDb().query("UPDATE messages SET extra=? WHERE id='m1'").run(JSON.stringify(extra));
      },
    });
    try {
      const result = await preprocess(["m0", "m1"].map((messageId) => ({ messageId, rawContent: content })));
      expect(result[0].content).toBe("Fresh Character");
      expect(captureMessageLiterals(result[1].content).content).toBe(content);
    } finally { unregister(); }
  });
});
