import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { chatsRoutes } from "./chats.routes";

const OWNER = "chat-mode-owner";
const CHAT_ID = "chat-mode-chat";

const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/chats", chatsRoutes);

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(OWNER, OWNER, `${OWNER}@example.test`);
  getDb().query("INSERT INTO chats (id, name, metadata, user_id) VALUES (?, ?, '{}', ?)").run(CHAT_ID, "Chat mode", OWNER);
});

afterEach(() => closeDatabase());

describe("chat Agentic mode CAS", () => {
  test("requires an explicit base revision for the first write and accepts exactly zero", async () => {
    const missing = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agentic" }),
    });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({
      error: "expectedRevision is required (use 0 for the first write)",
      code: "AGENT_CHAT_MODE_REVISION_REQUIRED",
    });

    const first = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agentic", expectedRevision: 0 }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ mode: "agentic", revision: 1, state: "ready", appliesTo: "next_turn" });
  });

  test("rejects malformed revisions and stale writes without changing the override", async () => {
    for (const expectedRevision of [-1, 1.5, "1", null]) {
      const response = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
        method: "PUT",
        headers: { "x-test-user": OWNER, "content-type": "application/json" },
        body: JSON.stringify({ mode: "agentic", expectedRevision }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }

    const first = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agentic", expectedRevision: 0 }),
    });
    expect(first.status).toBe(200);

    const stale = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "response", expectedRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "Chat agent mode changed; refresh and try again.",
      code: "AGENT_CHAT_MODE_REVISION_CONFLICT",
      currentMode: "agentic",
      currentRevision: 1,
      currentState: "ready",
      source: "durable_chat_override",
      appliesTo: "next_turn",
    });
    expect(getDb().query("SELECT mode, revision FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(OWNER, CHAT_ID)).toEqual({ mode: "agentic", revision: 1 });
  });

  test("returns a non-disclosing 404 for a missing owned chat", async () => {
    const response = await app.request("/chats/missing-chat/agent-mode", {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agentic", expectedRevision: 0 }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });

  test("returns a client error for malformed JSON without touching the override", async () => {
    const malformed = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: "{\"mode\":",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid JSON body", code: "INVALID_REQUEST" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(OWNER, CHAT_ID)).toEqual({ count: 0 });
  });
  test("resets to the preset with a CAS-protected DELETE", async () => {
    const first = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agentic", expectedRevision: 0 }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ mode: "agentic", revision: 1, appliesTo: "next_turn" });

    const reset = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      chatId: CHAT_ID,
      mode: null,
      revision: 2,
      state: "ready",
      appliesTo: "next_turn",
    });
    expect(getDb().query("SELECT mode, revision FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(OWNER, CHAT_ID)).toEqual({ mode: null, revision: 2 });

    const stale = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "AGENT_CHAT_MODE_REVISION_CONFLICT",
    });
    expect(getDb().query("SELECT mode, revision FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(OWNER, CHAT_ID)).toEqual({ mode: null, revision: 2 });
  });

  test("accepts only the closed mode write and reset DTOs", async () => {
    const unknownPut = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: "response", expectedRevision: 0, appliesTo: "next_turn" }),
    });
    expect(unknownPut.status).toBe(400);
    expect(await unknownPut.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const nullMode = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "PUT",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ mode: null, expectedRevision: 0 }),
    });
    expect(nullMode.status).toBe(400);
    expect(await nullMode.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const unknownDelete = await app.request(`/chats/${CHAT_ID}/agent-mode`, {
      method: "DELETE",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, mode: null }),
    });
    expect(unknownDelete.status).toBe(400);
    expect(await unknownDelete.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(OWNER, CHAT_ID)).toEqual({ count: 0 });
  });

});
