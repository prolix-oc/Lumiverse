import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { auth, allowCreation, CREATION_NONCE_HEADER } from "../auth";
import { getDb } from "../db/connection";
import { hashPassword, verifyPassword } from "../crypto/password";
import { rateLimit } from "../middleware/rate-limit";
import { purgeUser } from "../services/user-data/purge.service";
import { SYSTEM_SECRET_PRINCIPAL } from "../services/secrets.service";

const app = new Hono();

type UserRole = "user" | "admin" | "owner";

function getTargetUser(id: string): { id: string; role: UserRole } | null {
  return getDb()
    .query('SELECT id, role FROM "user" WHERE id = ?')
    .get(id) as { id: string; role: UserRole } | null;
}

function isOwnerSession(c: any): boolean {
  return c.get("session")?.user?.role === "owner";
}

function canManageTarget(c: any, targetRole: UserRole): boolean {
  if (isOwnerSession(c)) return true;
  return targetRole === "user";
}

// scrypt-backed endpoints: bound how often a single client can request work
// from the libuv thread pool. 5 attempts per 5 minutes per IP is generous for
// real users (typo, retry) but cripples a brute-force loop.
const passwordLimiter = rateLimit({
  bucket: "user-password",
  max: 5,
  windowMs: 5 * 60 * 1000,
  message: "Too many password attempts. Try again later.",
});

// ── Self-service (any authenticated user) ───────────────────────────────

// POST /me/password — change own password
app.post("/me/password", passwordLimiter, async (c) => {
  const session = c.get("session");
  const body = await c.req.json();

  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: "currentPassword and newPassword are required" }, 400);
  }

  if (body.newPassword.length < 8 || body.newPassword.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  const account = getDb()
    .query('SELECT password FROM account WHERE userId = ? AND providerId = ?')
    .get(session.user.id, "credential") as { password: string } | null;

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  const valid = await verifyPassword({
    hash: account.password,
    password: body.currentPassword,
  });
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 403);
  }

  const hashed = await hashPassword(body.newPassword);
  getDb().run(
    'UPDATE account SET password = ? WHERE userId = ? AND providerId = ?',
    [hashed, session.user.id, "credential"]
  );

  // Revoke all other sessions so stolen tokens are invalidated
  getDb().run(
    "DELETE FROM session WHERE userId = ? AND id != ?",
    [session.user.id, session.session.id]
  );

  return c.json({ success: true });
});

// ── Admin routes (require owner/admin role) ─────────────────────────────

const admin = new Hono();
admin.use("/*", requireOwner);

// GET / — list all users (the reserved system principal is not a login
// account and must never appear in the admin roster)
admin.get("/", (c) => {
  const rows = getDb()
    .query('SELECT id, name, email, username, role, banned, createdAt, updatedAt FROM "user" WHERE id != ? ORDER BY createdAt DESC')
    .all(SYSTEM_SECRET_PRINCIPAL);
  return c.json(rows);
});

// POST / — create a new user
const VALID_ROLES = new Set(["user", "admin", "owner"]);

admin.post("/", async (c) => {
  const body = await c.req.json();
  const callerIsOwner = isOwnerSession(c);
  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  if (body.password.length < 8 || body.password.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  // Reject arbitrary role strings up front — only the roles registered with
  // BetterAuth's admin plugin are valid.
  if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
    return c.json({ error: `Invalid role. Allowed: ${[...VALID_ROLES].join(", ")}` }, 400);
  }

  // Only the owner may mint privileged accounts. requireOwner admits admins
  // too, and an admin creating an "owner"-role account would otherwise be a
  // one-step self-escalation past every canManageTarget gate.
  if (body.role && body.role !== "user" && !isOwnerSession(c)) {
    return c.json({ error: "Only the owner can create admin or owner accounts" }, 403);
  }
  const creationNonce = allowCreation();

  try {
    const newUser = await auth.api.signUpEmail({
      headers: new Headers({
        [CREATION_NONCE_HEADER]: creationNonce,
      }),
      body: {
        email: `${body.username}@lumiverse.local`,
        password: body.password,
        name: body.name || body.username,
        username: body.username,
      },
    });

    if (body.role && body.role !== "user") {
      getDb().run('UPDATE "user" SET role = ? WHERE id = ?', [body.role, newUser.user.id]);
    }

    return c.json(newUser.user, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to create user" }, 400);
  }
});

// POST /:id/reset-password — admin password reset
admin.post("/:id/reset-password", passwordLimiter, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const targetUser = getTargetUser(id);

  if (!body.newPassword) {
    return c.json({ error: "newPassword is required" }, 400);
  }

  if (body.newPassword.length < 8 || body.newPassword.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only reset passwords for user-role accounts" }, 403);
  }

  const hashed = await hashPassword(body.newPassword);
  const result = getDb().run(
    'UPDATE account SET password = ? WHERE userId = ? AND providerId = ?',
    [hashed, id, "credential"]
  );

  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all sessions so user must log in with new password
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);

  return c.json({ success: true });
});

// POST /:id/ban — disable user login
admin.post("/:id/ban", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");
  const targetUser = getTargetUser(id);

  if (session.user.id === id) {
    return c.json({ error: "Cannot ban yourself" }, 400);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only ban user-role accounts" }, 403);
  }

  const result = getDb().run('UPDATE "user" SET banned = 1 WHERE id = ?', [id]);
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all sessions for banned user
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);

  return c.json({ success: true });
});

admin.post("/:id/unban", async (c) => {
  const { id } = c.req.param();

  const targetUser = getTargetUser(id);
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  // Mirror the ban gate: admins may only unban user-role accounts, so an
  // admin cannot resurrect another admin the owner has banned.
  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only unban user-role accounts" }, 403);
  }

  const result = getDb().run(
    'UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?',
    [id]
  );
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ success: true });
});

// DELETE /:id — delete user and every artifact they own (SQLite rows,
// LanceDB vectors, on-disk files, running extensions, MCP clients).
admin.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");
  const targetUser = getTargetUser(id);

  if (session.user.id === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  // Deleting the reserved system principal would CASCADE-wipe every
  // operator-provisioned system broker secret. Hard-reject regardless of
  // caller role.
  if (id === SYSTEM_SECRET_PRINCIPAL) {
    return c.json({ error: "The system principal cannot be deleted: it owns the system broker secrets" }, 409);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only delete user-role accounts" }, 403);
  }

  try {
    const report = await purgeUser(id);
    return c.json({ success: true, report });
  } catch (err: any) {
    console.error(`[users] purge failed for ${id}:`, err);
    return c.json({ error: err?.message || "Failed to delete user" }, 500);
  }
});

// Mount admin routes at the root of this router
app.route("/", admin);

export { app as usersRoutes };
