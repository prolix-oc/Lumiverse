import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import {
  DispatchStateError,
  computeDispatchDescriptorDigest,
  ensureDispatchState,
  readDispatchState,
  resolveDispatchDescriptor,
  resolveDispatchForSource,
  resolveMainDispatchSnapshot,
  resolveSlotDispatch,
  withDispatchStateTransaction,
} from "./dispatch-state.service";
import type { DispatchDescriptorDigestInput, DispatchDescriptorResolutionInput } from "./dispatch-state.service";

const USER_ID = "dispatch-user";
const CONNECTION_ID = "connection-1";
const PRESET_ID = "preset-1";
const SECRET_KEY = `connection_${CONNECTION_ID}_api_key`;
const SLOT_A_ID = "connection-slot-a";
const SLOT_B_ID = "connection-slot-b";
const SLOT_A_SECRET_KEY = `connection_${SLOT_A_ID}_api_key`;
const SLOT_B_SECRET_KEY = `connection_${SLOT_B_ID}_api_key`;

function digestInput(overrides: Partial<DispatchDescriptorDigestInput> = {}): DispatchDescriptorDigestInput {
  return {
    userId: USER_ID,
    source: "slot",
    baseToken: "a".repeat(32),
    connection: {
      id: CONNECTION_ID,
      name: "Loopback",
      provider: "openai-compatible",
      model: "loopback-model",
      apiUrl: "http://127.0.0.1:9876/v1",
      endpointOrigin: "http://127.0.0.1:9876/v1",
      presetId: PRESET_ID,
      isDefault: true,
      hasApiKey: true,
      metadata: { route: "chat", retry: { enabled: true } },
      dispatchKind: "concrete",
    },
    profile: { model: "loopback-model", updatedAt: 10 },
    preset: { id: PRESET_ID, parameters: { temperature: 0.2 } },
    reasoning: { effort: "low", apiReasoning: true },
    settings: { locale: "en" },
    encryptedSecret: {
      key: SECRET_KEY,
      encryptedValue: "ciphertext",
      iv: "iv-1",
      tag: "tag-1",
      updatedAt: 10,
    },
    ...overrides,
  };
}

async function resetDispatchDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  const db = getDb();
  db.run('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)', [USER_ID, "Dispatch User", "dispatch-user@example.test"]);
  db.run(
    `INSERT INTO presets
      (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [PRESET_ID, "Dispatch Preset", "openai-compatible", '{"temperature":0.2}', "[]", "{}", 10, 10, "{}", USER_ID, "classic"],
  );
  db.run(
    `INSERT INTO connection_profiles
      (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [CONNECTION_ID, "Loopback", "openai-compatible", "http://127.0.0.1:9876/v1", "loopback-model", PRESET_ID, 1, "{}", 10, 10, 1, USER_ID],
  );
  db.run(
    `INSERT INTO secrets (key, encrypted_value, iv, tag, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [SECRET_KEY, "ciphertext", "iv-1", "tag-1", 10, USER_ID],
  );
  for (const [id, name, model, secretKey] of [
    [SLOT_A_ID, "Slot A", "slot-a-model", SLOT_A_SECRET_KEY],
    [SLOT_B_ID, "Slot B", "slot-b-model", SLOT_B_SECRET_KEY],
  ] as const) {
    db.run(
      `INSERT INTO connection_profiles
        (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, "openai-compatible", "http://127.0.0.1:9876/v1", model, PRESET_ID, 0, "{}", 10, 10, 1, USER_ID],
    );
    db.run(
      `INSERT INTO secrets (key, encrypted_value, iv, tag, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [secretKey, `${model}-ciphertext`, "iv-1", "tag-1", 10, USER_ID],
    );
  }
}

beforeEach(resetDispatchDb);
afterEach(() => closeDatabase());

describe("dispatch descriptor digests", () => {
  test("is stable for object insertion order and changes each effective input", () => {
    const first = computeDispatchDescriptorDigest(digestInput());
    const reordered = computeDispatchDescriptorDigest(digestInput({
      connection: { ...digestInput().connection, metadata: { retry: { enabled: true }, route: "chat" } },
      profile: { updatedAt: 10, model: "loopback-model" },
    }));
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const changes: DispatchDescriptorDigestInput[] = [
      digestInput({ source: "main" }),
      digestInput({ baseToken: "b".repeat(32) }),
      digestInput({ reasoning: { effort: "high", apiReasoning: true } }),
      digestInput({ settings: { locale: "fr" } }),
      digestInput({ encryptedSecret: { ...digestInput().encryptedSecret!, encryptedValue: "new-ciphertext" } }),
      digestInput({ encryptedSecret: null }),
      digestInput({ profile: { model: "different-model" } }),
      digestInput({ preset: { id: PRESET_ID, parameters: { temperature: 0.8 } } }),
    ];
    for (const changed of changes) expect(computeDispatchDescriptorDigest(changed)).not.toBe(first);
    expect(() => computeDispatchDescriptorDigest({ ...digestInput(), connection: { ...digestInput().connection, dispatchKind: "roulette" } })).toThrow(DispatchStateError);
  });

  test("distinguishes a missing encrypted tuple from a present tuple", () => {
    const missing = computeDispatchDescriptorDigest(digestInput({ encryptedSecret: null }));
    const present = computeDispatchDescriptorDigest(digestInput({
      encryptedSecret: { key: SECRET_KEY, encryptedValue: "", iv: "", tag: "", updatedAt: 0 },
    }));
    expect(missing).not.toBe(present);
  });
});

describe("dispatch state and transaction authority", () => {
  test("registers dispatch migration/schema idempotently", async () => {
    await runMigrations(getDb());
    await runMigrations(getDb());
    expect(getDb().query("SELECT name FROM _migrations WHERE name = ?").get("094_dispatch_state.sql")).toEqual({ name: "094_dispatch_state.sql" });
    expect(getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_state'").get()).toEqual({ name: "dispatch_state" });
  });

  test("rejects async callbacks before they can escape the SQLite transaction", () => {
    expect(() => withDispatchStateTransaction(USER_ID, (() => Promise.resolve(1)) as never)).toThrow("synchronous");
  });

  test("returns opaque revisions and rejects stale or revisionless dispatch", () => {
    expect(readDispatchState(USER_ID)).toBeNull();
    const initial = ensureDispatchState(USER_ID);
    expect(initial.dispatchRevision).toBeNull();

    const inspection = resolveMainDispatchSnapshot(USER_ID, { presetId: PRESET_ID, reasoning: { effort: "low" }, settings: { locale: "en" } });
    expect(inspection.dispatchRevision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inspection.descriptor.connectionDispatchRevision).toBe(inspection.dispatchRevision);

    const request: DispatchDescriptorResolutionInput = {
      source: "slot",
      connectionId: CONNECTION_ID,
      expectedConnectionDispatchRevision: inspection.dispatchRevision,
      presetId: PRESET_ID,
      reasoning: { effort: "low" },
      settings: { locale: "en" },
    };
    expect(() => resolveDispatchForSource(USER_ID, { ...request, expectedConnectionDispatchRevision: undefined })).toThrow("revision");
    expect(() => resolveDispatchForSource(USER_ID, request)).toThrow("stale");

    const inspectedSlot = resolveDispatchDescriptor(USER_ID, { ...request, expectedConnectionDispatchRevision: undefined });
    const slot = resolveSlotDispatch(USER_ID, CONNECTION_ID, inspectedSlot.dispatchRevision, { presetId: PRESET_ID, reasoning: { effort: "low" }, settings: { locale: "en" } });
    expect(slot.source).toBe("slot");
    expect(slot.dispatchRevision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slot.dispatchRevision).not.toBe(inspection.dispatchRevision);
  });

  test("keeps Main and slot revisions consumable until a real mutation", () => {
    const context = {
      presetId: PRESET_ID,
      reasoning: { effort: "low" },
      settings: { locale: "en" },
    };
    const initial = ensureDispatchState(USER_ID);
    const main = resolveMainDispatchSnapshot(USER_ID, context);
    const slotA = resolveDispatchDescriptor(USER_ID, {
      source: "slot",
      connectionId: SLOT_A_ID,
      ...context,
    });
    const slotB = resolveDispatchDescriptor(USER_ID, {
      source: "slot",
      connectionId: SLOT_B_ID,
      ...context,
    });

    expect(main.dispatchRevision).not.toBe(slotA.dispatchRevision);
    expect(main.dispatchRevision).not.toBe(slotB.dispatchRevision);
    expect(slotA.dispatchRevision).not.toBe(slotB.dispatchRevision);
    expect(readDispatchState(USER_ID)).toMatchObject({
      generation: initial.generation,
      revision: initial.revision,
      descriptorDigest: initial.descriptorDigest,
    });

    const mainRequest: DispatchDescriptorResolutionInput = {
      source: "main",
      expectedDispatchRevision: main.dispatchRevision,
      ...context,
    };
    const slotARequest: DispatchDescriptorResolutionInput = {
      source: "slot",
      connectionId: SLOT_A_ID,
      expectedConnectionDispatchRevision: slotA.dispatchRevision,
      ...context,
    };
    const slotBRequest: DispatchDescriptorResolutionInput = {
      source: "slot",
      connectionId: SLOT_B_ID,
      expectedConnectionDispatchRevision: slotB.dispatchRevision,
      ...context,
    };

    expect(resolveDispatchForSource(USER_ID, mainRequest).dispatchRevision).toBe(main.dispatchRevision);
    expect(resolveDispatchForSource(USER_ID, slotARequest).dispatchRevision).toBe(slotA.dispatchRevision);
    expect(resolveDispatchForSource(USER_ID, slotBRequest).dispatchRevision).toBe(slotB.dispatchRevision);
    expect(readDispatchState(USER_ID)).toMatchObject({
      generation: initial.generation,
      revision: initial.revision,
      descriptorDigest: initial.descriptorDigest,
    });

    const changedState = withDispatchStateTransaction(USER_ID, (tx) => {
      getDb()
        .query("UPDATE connection_profiles SET model = ?, updated_at = updated_at + 1 WHERE id = ? AND user_id = ?")
        .run("slot-a-mutated-model", SLOT_A_ID, USER_ID);
      const reconciled = tx.resolve({
        source: "slot",
        connectionId: SLOT_A_ID,
        ...context,
      });
      expect(reconciled.descriptorDigest).not.toBe(slotA.descriptorDigest);
      return tx.mutate({ incrementGeneration: true });
    });
    expect(changedState.revision).toBe(initial.revision + 1);

    for (const request of [mainRequest, slotARequest, slotBRequest]) {
      expect(() => resolveDispatchForSource(USER_ID, request)).toThrow("stale");
    }
  });

  test("rejects foreign, unresolved, and roulette destinations", () => {
    expect(() => resolveDispatchDescriptor("missing-user", { source: "main" })).toThrow("user");
    expect(() => resolveDispatchDescriptor(USER_ID, { source: "slot", connectionId: "foreign" })).toThrow("connection");
    getDb().run(
      `INSERT INTO connection_profiles
        (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["roulette", "Roulette", "model_roulette", "", "", null, 0, "{}", 10, 10, 0, USER_ID],
    );
    expect(() => resolveDispatchDescriptor(USER_ID, { source: "slot", connectionId: "roulette" })).toThrow("Roulette");
  });
});
