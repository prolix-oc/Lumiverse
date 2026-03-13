import type { Context, Next } from "hono";
import { auth } from "./index";
import { getDb } from "../db/connection";
import { getFirstUserId } from "./seed";

// Augment Hono's context variables
declare module "hono" {
  interface ContextVariableMap {
    session: {
      user: {
        id: string;
        name: string;
        email: string;
        role?: string | null;
        username?: string | null;
        [key: string]: any;
      };
      session: {
        id: string;
        userId: string;
        token: string;
        expiresAt: Date;
        [key: string]: any;
      };
    };
    userId: string;
  }
}

export async function requireAuth(c: Context, next: Next) {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // BetterAuth's admin plugin adds the `role` field to the user schema, but
  // getSession() sometimes omits it (adapter/transform quirks with plugin-
  // defined columns).  When missing, read it directly from the DB so every
  // downstream handler (spindle privilege check, requireOwner, etc.) sees the
  // real role instead of the "user" fallback.
  if (!session.user.role) {
    const row = getDb()
      .query('SELECT role FROM "user" WHERE id = ?')
      .get(session.user.id) as { role: string } | null;
    if (row?.role) {
      session.user.role = row.role;
    }
  }

  // Self-healing: the first-created user (user 0) is ALWAYS the instance
  // owner. If their role is somehow not "owner" (seed race, DB restore,
  // BetterAuth reset), fix it on the fly so they never lose access.
  if (session.user.role !== "owner") {
    const cachedFirstId = getFirstUserId();
    if (cachedFirstId && cachedFirstId === session.user.id) {
      getDb().run('UPDATE "user" SET role = ? WHERE id = ?', ["owner", session.user.id]);
      session.user.role = "owner";
      console.log(`[Auth] Self-healed owner role for first user ${session.user.id}`);
    }
  }

  c.set("session", session);
  c.set("userId", session.user.id);

  return next();
}

export async function requireOwner(c: Context, next: Next) {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const role = session.user.role;
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  return next();
}
