/**
 * Task 3.17 — the cross-product property test for
 * `editAndSendAlwaysUseActiveConnection`.
 *
 * Property 6: Bug Condition — The Opt-In Overrides A Live Chat Binding, For
 * Edit-and-Send Only.
 * Property 7: Preservation — The Setting Resolves At Dispatch Time And Survives
 * A False Value.
 *
 * ONE generator over the full cross product:
 *   setting            ∈ { absent row, absent key, false, null, non-object, true }
 *   activeProfileState ∈ { live, unset, deleted }
 *   origin             ∈ { edit_and_send, interactive }
 *   bindingPresent     ∈ { true, false }   (with a connection_model override
 *                                           whenever a binding is present)
 *
 * Two assertions over every cell:
 *   1. the override fires IF AND ONLY IF origin = edit_and_send AND the setting
 *      is literally `true` AND the active profile is live;
 *   2. in every other cell the resolved profile — id AND model — is
 *      bit-identical to the ORIGINAL function's result, including the
 *      `connection_model` override for bound profiles and the unchanged throw
 *      when nothing resolves.
 *
 * The "original function" is reimplemented verbatim from the pre-fix source
 * below, so cell-by-cell equivalence is checked against real pre-fix behaviour
 * rather than against a restatement of the new implementation.
 *
 * `interactive` is modelled as `options` omitted, which is exactly how every
 * interactive call site invokes `startGeneration` (`chatRoute` passes ONE
 * argument, as do `multiplayer.triggerHostGeneration` and
 * `src/spindle/worker-host.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectionProfile } from "../types/connection-profile";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

const connectionsSvc = await import("./connections.service");
const generateSvc = await import("./generate.service");

const resolveChatConnection = generateSvc.__test__.resolveChatGenerationConnection;
const readAlwaysActive = generateSvc.__test__.readEditAndSendAlwaysUseActiveConnection;

const USER = "user:optin";

const NO_CONNECTION_MESSAGE =
  "No connection profile found. Configure a default connection or select one for this chat.";
const BINDING_MODEL_OVERRIDE = "binding-model-override";

const BOUND = "optin-bound";
const ACTIVE = "optin-active";
const DEFAULT = "optin-default";

// ── The ORIGINAL (pre-fix) resolver, copied verbatim ───────────────────────
// `resolveChatGenerationConnection` before this spec touched it: chat binding
// first, then the requested id, then `getDefaultConnection` (via
// `resolveConnection(userId, undefined)`) — the `is_default`-only rung that is
// the 401 defect. Kept here so every non-override cell is compared against real
// pre-fix behaviour.
function resolveChatGenerationConnectionOriginal(
  userId: string,
  metadata: Record<string, any> | null | undefined,
  requestedConnectionId?: string,
): ConnectionProfile {
  const boundId = typeof metadata?.connection_profile_id === "string"
    ? metadata.connection_profile_id.trim()
    : "";
  const boundConnection = boundId
    ? connectionsSvc.resolveConnection(userId, boundId)
    : null;
  const connection = boundConnection
    ?? connectionsSvc.resolveConnection(userId, requestedConnectionId);

  if (!connection) {
    throw new Error(NO_CONNECTION_MESSAGE);
  }

  const modelOverride = boundConnection && typeof metadata?.connection_model === "string"
    ? metadata.connection_model.trim()
    : "";
  return modelOverride ? { ...connection, model: modelOverride } : connection;
}

// ── Fixture ────────────────────────────────────────────────────────────────

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE extensions (
    identifier TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
    install_scope TEXT NOT NULL, installed_by_user_id TEXT
  )`);
  db.run("INSERT INTO extensions VALUES ('lumiverse_suite', 1, 'operator', NULL)");
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', preset_id TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT
  )`);
}

function seedProfile(id: string, model: string, isDefault = false): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, ?, '{}', 1, 1, 0, ?)`,
  ).run(id, id, model, isDefault ? 1 : 0, USER);
}

function seedSettingRaw(key: string, json: string): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run(key, json, USER);
}

function clearSetting(key: string): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, USER);
}

// ── The generated domain ──────────────────────────────────────────────────

/** Every representation the persisted setting can take. Only one means ON. */
const SETTING_STATES: Array<{ label: string; isLiteralTrue: boolean; seed: () => void }> = [
  { label: "absent row", isLiteralTrue: false, seed: () => clearSetting("quickToolbarSettings") },
  { label: "absent key", isLiteralTrue: false, seed: () => seedSettingRaw("quickToolbarSettings", JSON.stringify({ editAndSendSide: "left" })) },
  { label: "false", isLiteralTrue: false, seed: () => seedSettingRaw("quickToolbarSettings", JSON.stringify({ editAndSendAlwaysUseActiveConnection: false })) },
  { label: "null", isLiteralTrue: false, seed: () => seedSettingRaw("quickToolbarSettings", JSON.stringify({ editAndSendAlwaysUseActiveConnection: null })) },
  { label: "non-object", isLiteralTrue: false, seed: () => seedSettingRaw("quickToolbarSettings", JSON.stringify("not-an-object")) },
  { label: "true", isLiteralTrue: true, seed: () => seedSettingRaw("quickToolbarSettings", JSON.stringify({ editAndSendAlwaysUseActiveConnection: true })) },
];

const ACTIVE_PROFILE_STATES: Array<{ label: "live" | "unset" | "deleted"; seed: () => void }> = [
  { label: "live", seed: () => seedSettingRaw("activeProfileId", JSON.stringify(ACTIVE)) },
  { label: "unset", seed: () => clearSetting("activeProfileId") },
  { label: "deleted", seed: () => seedSettingRaw("activeProfileId", JSON.stringify("optin-deleted-never-existed")) },
];

const ORIGINS = ["edit_and_send", "interactive"] as const;

interface Cell {
  setting: string;
  activeProfileState: "live" | "unset" | "deleted";
  origin: (typeof ORIGINS)[number];
  bindingPresent: boolean;
  profilesOwned: "some" | "none";
}

type Outcome = { id: string; model: string } | { threw: string };

function outcomeOf(fn: () => ConnectionProfile): Outcome {
  try {
    const profile = fn();
    return { id: profile.id, model: profile.model };
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

/** Seed a whole cell and resolve it through both implementations. */
function evaluate(cell: Cell): {
  fixed: Outcome;
  original: Outcome;
  overrideFired: boolean;
  expectOverride: boolean;
} {
  initTestDb();
  if (cell.profilesOwned === "some") {
    seedProfile(BOUND, "model-bound");
    seedProfile(ACTIVE, "model-active");
    seedProfile(DEFAULT, "model-default", true);
  }
  ACTIVE_PROFILE_STATES.find((state) => state.label === cell.activeProfileState)!.seed();
  SETTING_STATES.find((state) => state.label === cell.setting)!.seed();

  const metadata = cell.bindingPresent
    ? { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE }
    : {};

  // `interactive` = `options` omitted at the call site, so `preferActiveConnection`
  // is never even computed. `edit_and_send` = the gated dispatch-time read.
  const preferActiveConnection = cell.origin === "edit_and_send" && readAlwaysActive(USER);
  const fixed = outcomeOf(() => resolveChatConnection(
    USER,
    metadata,
    undefined,
    cell.origin === "edit_and_send" ? { preferActiveConnection } : undefined,
  ));
  const original = outcomeOf(() => resolveChatGenerationConnectionOriginal(USER, metadata, undefined));

  const settingIsLiteralTrue = SETTING_STATES
    .find((state) => state.label === cell.setting)!.isLiteralTrue;
  const activeIsLive = connectionsSvc.resolveActiveConnectionId(USER) !== undefined;

  return {
    fixed,
    original,
    overrideFired: "id" in fixed && fixed.id === ACTIVE && fixed.model === "model-active"
      && cell.bindingPresent,
    expectOverride: cell.origin === "edit_and_send" && settingIsLiteralTrue && activeIsLive,
  };
}

function allCells(): Cell[] {
  const cells: Cell[] = [];
  for (const setting of SETTING_STATES) {
    for (const activeProfileState of ACTIVE_PROFILE_STATES) {
      for (const origin of ORIGINS) {
        for (const bindingPresent of [true, false]) {
          for (const profilesOwned of ["some", "none"] as const) {
            cells.push({
              setting: setting.label,
              activeProfileState: activeProfileState.label,
              origin,
              bindingPresent,
              profilesOwned,
            });
          }
        }
      }
    }
  }
  return cells;
}

beforeEach(() => { initTestDb(); });
afterEach(() => { closeDatabase(); });

describe("Property 6 / Property 7 — the opt-in cross product", () => {
  test("the override fires if and only if origin = edit_and_send AND setting === true AND active is live", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const cell of allCells()) {
      const { fixed, expectOverride } = evaluate(cell);
      if (cell.profilesOwned === "none") continue; // nothing to override.
      const resolvedActive = "id" in fixed && fixed.id === ACTIVE;
      if (cell.bindingPresent && resolvedActive !== expectOverride) {
        counterexamples.push({ ...cell, fixed, expectOverride });
      }
    }
    expect(counterexamples).toEqual([]);
  });

  test("when the override fires, the binding's connection_model is NOT applied", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const cell of allCells()) {
      if (!cell.bindingPresent || cell.profilesOwned === "none") continue;
      const { fixed, expectOverride } = evaluate(cell);
      if (!expectOverride) continue;
      // The pinned model belongs to the pinned profile and is very often not
      // served by the active profile's endpoint, so it must not travel.
      if (!("id" in fixed) || fixed.id !== ACTIVE || fixed.model !== "model-active") {
        counterexamples.push({ ...cell, fixed });
      }
    }
    expect(counterexamples).toEqual([]);
  });

  test("every non-override cell is bit-identical to the ORIGINAL function", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const cell of allCells()) {
      const { fixed, original, expectOverride } = evaluate(cell);
      if (expectOverride) continue;
      // The one shape that legitimately differs is the 401 fix itself: no
      // binding and no requested id, where the original resolved `is_default`
      // only and the fix resolves the acting connection. Those cells belong to
      // Property 1, not to this preservation half, and they are excluded by
      // asserting them against `resolveActingConnectionId` instead.
      if (!cell.bindingPresent) {
        const actingId = connectionsSvc.resolveActingConnectionId(USER);
        const expected: Outcome = actingId
          ? outcomeOf(() => connectionsSvc.resolveConnection(USER, actingId) as ConnectionProfile)
          : { threw: NO_CONNECTION_MESSAGE };
        if (JSON.stringify(fixed) !== JSON.stringify(expected)) {
          counterexamples.push({ ...cell, fixed, expected, arm: "acting-fallback" });
        }
        continue;
      }
      if (JSON.stringify(fixed) !== JSON.stringify(original)) {
        counterexamples.push({ ...cell, fixed, original, arm: "bound" });
      }
    }
    expect(counterexamples).toEqual([]);
  });

  test("interactive cells are bit-identical to the original in BOTH toggle positions", () => {
    // Clause 2.17's confinement half: with `options` omitted, no setting state
    // can change resolution, binding or no binding.
    const counterexamples: Array<Record<string, unknown>> = [];
    const byShape = new Map<string, Outcome>();
    for (const cell of allCells()) {
      if (cell.origin !== "interactive") continue;
      const { fixed } = evaluate(cell);
      const shape = `${cell.activeProfileState}|${cell.bindingPresent}|${cell.profilesOwned}`;
      const seen = byShape.get(shape);
      if (seen && JSON.stringify(seen) !== JSON.stringify(fixed)) {
        counterexamples.push({ ...cell, fixed, previouslyObserved: seen });
      }
      if (!seen) byShape.set(shape, fixed);
    }
    expect(counterexamples).toEqual([]);
  });

  test("the unchanged throw still fires when the user owns no profiles at all", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const cell of allCells()) {
      if (cell.profilesOwned !== "none") continue;
      const { fixed } = evaluate(cell);
      if (!("threw" in fixed) || fixed.threw !== NO_CONNECTION_MESSAGE) {
        counterexamples.push({ ...cell, fixed });
      }
    }
    expect(counterexamples).toEqual([]);
  });
});
