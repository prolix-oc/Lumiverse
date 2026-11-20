import { getDb } from "../db/connection";

/** Match the extension list's enabled state and per-user installation visibility. */
export function hasEnabledExtensionForUser(userId: string, identifier: string): boolean {
  const db = getDb();
  const extension = db.query(
    "SELECT install_scope, installed_by_user_id FROM extensions WHERE identifier = ? AND enabled = 1",
  ).get(identifier) as { install_scope: string; installed_by_user_id: string | null } | null;
  if (!extension) return false;
  if (extension.install_scope === "operator" || extension.installed_by_user_id === userId) return true;
  const user = db.query('SELECT role FROM "user" WHERE id = ?').get(userId) as { role: string } | null;
  return user?.role === "owner" || user?.role === "admin";
}
