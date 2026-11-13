import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chats from "../services/chats.service";
import * as regex from "../services/regex-scripts.service";
import { macrosRoutes } from "./macros.routes";
import { chatsRoutes } from "./chats.routes";
import { regexScriptsRoutes } from "./regex-scripts.routes";
import { presetHistoryDependency } from "../types/preset-history";

const userId = "history-owner";
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/macros", macrosRoutes); app.route("/regex", regexScriptsRoutes); app.route("/chats", chatsRoutes);
beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:"); getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(closeDatabase);
async function post(path: string, body: unknown) {
  const response = await app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(200); return response.json();
}
test("preview, batch, and display preprocessing agree and expose history dependencies", async () => {
  const chat = chats.createChat(userId, {});
  const message = chats.createMessage(chat.id, { is_user: false, name: "Assistant", content: "Reply",
    extra: { generationMetrics: { presetId: "deleted", presetName: "Recorded" } } }, userId);
  const resolved = await post("/macros/resolve", { template: "{{lastPreset}}", chat_id: chat.id });
  expect(resolved.text).toBe("Recorded"); expect(resolved.touched_vars).toContain(presetHistoryDependency(chat.id));
  const batch = await post("/macros/resolve-batch", { templates: { one: "{{lastPreset}}", many: "{{lastPresets::5::, }}" }, chat_id: chat.id });
  expect(batch.resolved).toEqual({ one: "Recorded", many: "Recorded" });
  const display = await post(`/chats/${chat.id}/display-preprocess`, { messageId: message.id, rawContent: "Last: {{lastPreset}}", role: "assistant" });
  expect(display.content).toBe("Last: Recorded"); expect(display.touchedVars).toEqual([presetHistoryDependency(chat.id)]);
  const batchedDisplay = await post(`/chats/${chat.id}/display-preprocess`, { items: [{ messageId: message.id, rawContent: "{{lastPreset}}", role: "assistant" }] });
  expect(batchedDisplay.items[0].touchedVars).toEqual([presetHistoryDependency(chat.id)]);
});
test("backend result-cache hits validate history even when body and scripts stay identical", async () => {
  const chat = chats.createChat(userId, {});
  const rule = regex.createRegexScript(userId, { name: "History", target: ["display"], placement: ["ai_output"],
    find_regex: "^TOKEN$", replace_string: "{{lastPreset}}", substitute_macros: "after" });
  if (typeof rule === "string") throw new Error(rule);
  const request = { content: "TOKEN", scripts: [rule], preprocessed: true, context: { chat_id: chat.id, is_user: false, depth: 0 } };
  expect((await post("/regex/apply", request)).result).toBe("");
  // Direct writes bypass event-driven invalidation: cache-hit dependency validation must still catch them.
  const message = chats.createMessage(chat.id, { is_user: false, name: "Assistant", content: "Reply",
    extra: { generationMetrics: { presetId: "a", presetName: "A" } } }, userId);
  expect((await post("/regex/apply", request)).result).toBe("A");
  getDb().query("UPDATE messages SET extra = json_set(extra, '$.generationMetricsBySwipe[0].presetName', 'B') WHERE id = ?").run(message.id);
  expect((await post("/regex/apply", request)).result).toBe("B");
});
