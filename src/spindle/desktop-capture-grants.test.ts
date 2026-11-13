import { afterEach, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../db/connection";
import { getDesktopCaptureGrantRevision, grantPermission, revokePermission } from "./manager.service";

afterEach(closeDatabase);

test.each([true, false])("capture approval detects offline revoke/regrant (scoped schema: %s)", scoped => {
  const db = initDatabase(":memory:");
  db.run("CREATE TABLE extensions (id TEXT PRIMARY KEY, identifier TEXT, install_scope TEXT, installed_by_user_id TEXT)");
  db.run(`CREATE TABLE extension_grants (id TEXT PRIMARY KEY, extension_id TEXT, permission TEXT${scoped ? ", scope TEXT, UNIQUE(extension_id, permission, scope)" : ", UNIQUE(extension_id, permission)"})`);
  db.run("INSERT INTO extensions VALUES ('installed', 'capture-test', 'system', NULL)");
  grantPermission("capture-test", "screen_capture");
  grantPermission("capture-test", "generation");
  const initial = getDesktopCaptureGrantRevision("capture-test", "screen_capture");
  // Repeated approval and unrelated permissions must not invalidate the native choice.
  grantPermission("capture-test", "screen_capture");
  grantPermission("capture-test", "screen_recording");
  expect(getDesktopCaptureGrantRevision("capture-test", "screen_capture")).toBe(initial);
  if (scoped) {
    db.run("INSERT INTO extension_grants VALUES ('other-scope', 'installed', 'screen_capture', 'user:other')");
    expect(getDesktopCaptureGrantRevision("capture-test", "screen_capture")).toBe(initial);
  }
  revokePermission("capture-test", "screen_capture");
  grantPermission("capture-test", "screen_capture");
  const regranted = getDesktopCaptureGrantRevision("capture-test", "screen_capture");
  expect(regranted).not.toBe(initial);
  revokePermission("capture-test", "generation");
  grantPermission("capture-test", "generation");
  expect(getDesktopCaptureGrantRevision("capture-test", "screen_capture")).not.toBe(regranted);
});
