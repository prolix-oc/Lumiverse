import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chats from "../services/chats.service";
import { chatsRoutes } from "./chats.routes";

const user = "message-role-route";
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", user); await next(); });
app.route("/", chatsRoutes);

beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(() => closeDatabase());

test("the message update route cannot change who sent a message", async () => {
  const chat = chats.createChatRaw(user, { character_id: "character" });
  const message = chats.createMessage(chat.id, { is_user: false, name: "Character", content: "Reply" }, user);
  const response = await app.request(`http://localhost/${chat.id}/messages/${message.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ is_user: true, name: "Renamed" }),
  });
  expect(response.status).toBe(200);
  expect(chats.getMessage(user, message.id)).toMatchObject({ is_user: false, name: "Renamed" });
});
