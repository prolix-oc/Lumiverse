import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { auth, allowCreation } from "../auth";
import { getDb } from "../db/connection";
import { getUserBaseDir } from "../auth/provision";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { rmSync, existsSync } from "fs";

const app = new Hono();

// ── Self-service (any authenticated user) ───────────────────────────────

// POST /me/password — change own password
app.post("/me/password", async (c) => {
  const session = c.get("session");
  const body = await c.req.json();

  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: "currentPassword and newPassword are required" }, 400);
  }

  if (body.newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
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

// GET / — list all users
admin.get("/", (c) => {
  const rows = getDb()
    .query('SELECT id, name, email, username, role, banned, createdAt, updatedAt FROM "user" ORDER BY createdAt DESC')
    .all();
  return c.json(rows);
});

// POST / — create a new user
admin.post("/", async (c) => {
  const body = await c.req.json();
  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  allowCreation();

  try {
    const newUser = await auth.api.signUpEmail({
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
admin.post("/:id/reset-password", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  if (!body.newPassword) {
    return c.json({ error: "newPassword is required" }, 400);
  }

  if (body.newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
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

  if (session.user.id === id) {
    return c.json({ error: "Cannot ban yourself" }, 400);
  }

  const result = getDb().run('UPDATE "user" SET banned = 1 WHERE id = ?', [id]);
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all sessions for banned user
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);

  return c.json({ success: true });
});

// POST /:id/unban — re-enable user login
admin.post("/:id/unban", async (c) => {
  const { id } = c.req.param();

  const result = getDb().run(
    'UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?',
    [id]
  );
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ success: true });
});

// DELETE /:id — delete user and all associated data
admin.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");

  if (session.user.id === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const user = getDb().query('SELECT id FROM "user" WHERE id = ?').get(id);
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  // Delete auth records (content tables cascade via user_id FK)
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);
  getDb().run("DELETE FROM account WHERE userId = ?", [id]);
  getDb().run('DELETE FROM "user" WHERE id = ?', [id]);

  // Clean up file system
  const userDir = getUserBaseDir(id);
  if (existsSync(userDir)) {
    rmSync(userDir, { recursive: true, force: true });
  }

  return c.json({ success: true });
});

// Mount admin routes at the root of this router
app.route("/", admin);

export { app as usersRoutes };
