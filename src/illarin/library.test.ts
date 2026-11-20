import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createPreset, deletePreset } from "../services/presets.service";
import * as instances from "../services/illarin-instance.service";
import * as manager from "../spindle/manager.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as api from "./api";
import * as tokens from "./tokens";
import * as warmup from "./warmup";
import {
  buildIllarinLibraryEntries, reportLibrary, reportPresetLibraryChange, subscribePresetLibraryChanges,
} from "./extensions";
import { clearPermissionError } from "./permission-state";
import type { LibrarySyncRequest } from "./types";

const USER_ID = "library-user";
const OTHER_USER_ID = "other-user";
const requests: Array<{ baseUrl: string; body: LibrarySyncRequest }> = [];
let extensions: ExtensionInfo[] = [];
let permissions = ["library:sync"];
const restores: Array<{ mockRestore(): void }> = [];
let unsubscribe: (() => void) | undefined;

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  for (const userId of [USER_ID, OTHER_USER_ID]) {
    getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(userId, userId, `${userId}@example.test`);
    clearPermissionError(userId);
  }
  requests.length = 0;
  extensions = [];
  permissions = ["library:sync"];
  restores.push(
    spyOn(manager, "list").mockImplementation(async () => extensions),
    spyOn(instances, "getIllarinInstance").mockImplementation(async (userId) => ({
      userId, illarinUrl: `https://${userId}.example.test`, scopes: permissions,
    } as any)),
    spyOn(tokens, "withAccessToken").mockImplementation(async (_userId, action) => action("synthetic-token")),
    spyOn(warmup, "readBackendVersion").mockImplementation(async () => "9.9.9"),
    spyOn(api, "syncLibrary").mockImplementation(async (baseUrl, _token, body) => {
      requests.push({ baseUrl, body });
      return { accepted: body.entries.length, ignored: 0, removed: body.removed?.length ?? 0, takedowns: [] };
    }),
  );
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const spy of restores.splice(0)) spy.mockRestore();
  closeDatabase();
});

function preset(workId: string, versionNumber?: number, userId = USER_ID, source = "illarin") {
  return createPreset(userId, {
    name: "Synthetic preset", provider: "loom",
    metadata: {
      _lumiverse_install_source: source, _lumiverse_illarin_asset_id: workId,
      ...(versionNumber === undefined ? {} : { _lumiverse_illarin_version_number: versionNumber }),
    },
  });
}

test("snapshots include owned presets and shared extensions, exclude local and foreign presets, and deduplicate work IDs", async () => {
  preset("preset-work", 2);
  preset("preset-work", 4);
  preset("legacy-work");
  preset("foreign-work", 6, OTHER_USER_ID);
  preset("copied-provenance", 7, USER_ID, "local");
  extensions = [{ metadata: { illarin: { workId: "extension-work", versionNumber: 3 } } } as unknown as ExtensionInfo];
  await reportLibrary(USER_ID);
  expect(requests).toEqual([{
    baseUrl: `https://${USER_ID}.example.test`, body: {
      snapshot: true, appVersion: "9.9.9",
      entries: [{ workId: "preset-work", versionNumber: 4 }, { workId: "legacy-work" }, { workId: "extension-work", versionNumber: 3 }],
    },
  }]);
});

test("legacy Illarin identities are reported without inventing numeric versions from labels", async () => {
  createPreset(USER_ID, { name: "Legacy preset", provider: "loom", metadata: {
    _lumiverse_install_source: "illarin", _lumiverse_lumihub_id: "legacy-work", _lumiverse_preset_version: "999",
  } });
  expect(await buildIllarinLibraryEntries(USER_ID)).toEqual([{ workId: "legacy-work" }]);
});

test("preset deltas report the current release to only the receiving installation", async () => {
  preset("work", 5);
  preset("other-work", 6, OTHER_USER_ID);
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests).toEqual([{
    baseUrl: `https://${USER_ID}.example.test`,
    body: { snapshot: false, appVersion: "9.9.9", entries: [{ workId: "work", versionNumber: 5 }], removed: [] },
  }]);
});

test("deleting one copy retains the other, and deleting the last copy sends a removal", async () => {
  const first = preset("work", 2);
  const second = preset("work", 3);
  deletePreset(USER_ID, first.id);
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests[0].body).toMatchObject({ entries: [{ workId: "work", versionNumber: 3 }], removed: [] });
  deletePreset(USER_ID, second.id);
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests[1].body).toEqual({ snapshot: false, appVersion: "9.9.9", entries: [], removed: ["work"] });
});

test("declining library permission prevents snapshots and deltas without affecting local installs", async () => {
  permissions = ["work:receive"];
  preset("work", 2);
  await reportLibrary(USER_ID);
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests).toEqual([]);
});

test("completed installs and deletions trigger scoped reports through the worker subscription", async () => {
  unsubscribe = subscribePresetLibraryChanges(USER_ID);
  const owned = preset("work", 2);
  eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
    source: "illarin", type: "preset", characterId: owned.id,
  }, OTHER_USER_ID);
  eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
    source: "illarin", type: "preset", characterId: owned.id,
  }, USER_ID);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Await the per-user queue, including the report scheduled by the event.
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.baseUrl === `https://${USER_ID}.example.test`)).toBe(true);
  requests.length = 0;
  deletePreset(USER_ID, owned.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reportPresetLibraryChange(USER_ID, "work");
  expect(requests).toHaveLength(2);
  expect(requests[0].body.removed).toEqual(["work"]);
  unsubscribe();
  unsubscribe = undefined;
  requests.length = 0;
  eventBus.emit(EventType.PRESET_DELETED, { id: "deleted", illarinWorkId: "work" }, USER_ID);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests).toEqual([]);
});
