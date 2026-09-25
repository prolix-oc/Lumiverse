import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createConnection } from "../services/decision-connections.service";
import { WorkerHostDecisionsApi } from "./worker-host-decisions-api";

describe("Spindle decisions permission", () => {
  test("denies evaluation before resolving any user or connection", async () => {
    const messages: any[] = [];
    let resolved = false;
    const bridge = new WorkerHostDecisionsApi({
      hasPermission: () => false,
      resolveEffectiveUserId: () => { resolved = true; return "alice"; },
      enforceScopedUser: () => {},
      post: (message) => messages.push(message),
    });
    await bridge.handleEvaluate("req", { state: "x", questions: { yes: { type: "noul", instructions: "yes?" } } });
    expect(resolved).toBe(false);
    expect(messages[0].error).toContain("decisions");
  });

  test("rejects an operator call without a bound user context", async () => {
    const messages: any[] = [];
    const bridge = new WorkerHostDecisionsApi({
      hasPermission: () => true,
      resolveEffectiveUserId: () => "",
      enforceScopedUser: () => { throw new Error("unexpected user scope"); },
      post: (message) => messages.push(message),
    });
    await bridge.handleEvaluate("req", { state: "x", questions: { yes: { type: "noul", instructions: "yes?" } } });
    expect(messages[0].error).toContain("user context");
  });

  test("a grant reaches only the scoped user's connection", async () => {
    initDatabase(":memory:");
    try {
      getDb().exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE secrets (key TEXT, user_id TEXT, value TEXT);');
      getDb().exec(readFileSync(new URL("../db/migrations/122_decision_connections.sql", import.meta.url), "utf8"));
      getDb().query('INSERT INTO "user" (id) VALUES (?), (?)').run("alice", "bob");
      const alice = await createConnection("alice", { name: "Alice Jev", gateway: "typesafe" });
      const messages: any[] = [];
      const scoped: string[] = [];
      const bridge = new WorkerHostDecisionsApi({
        hasPermission: (permission) => permission === "decisions",
        resolveEffectiveUserId: () => "bob",
        enforceScopedUser: (userId) => scoped.push(userId),
        post: (message) => messages.push(message),
      });
      await bridge.handleEvaluate("req", { connectionId: alice.id, state: "x", questions: { yes: { type: "noul", instructions: "yes?" } } });
      expect(scoped).toEqual(["bob"]);
      expect(messages[0].error).toContain("not found");
    } finally { closeDatabase(); }
  });
});
