import type { Context, Next } from "hono";
import { auth } from "./index";
import { getDb } from "../db/connection";
import { getFirstUserId } from "./seed";
import { authLockoutService } from "../services/auth-lockout.service";
import { getClientIp } from "../utils/client-ip";

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
  const clientId = getClientIp(c);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    const result = authLockoutService.recordFailure(clientId, "unauthorized", {
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin") || undefined,
      host: c.req.header("host") || undefined,
    });
    if (result.lockout) {
      c.header("Retry-After", String(result.lockout.retryAfterMs / 1000));
      return c.json(
        authLockoutService.buildPayload(result.lockout, "Too many unauthorized requests. Try again later."),
        429,
      );
    }
    return c.json({ error: "Unauthorized" }, 401);
  }

  authLockoutService.recordSuccess(clientId, "unauthorized");

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

/**
 * Owner-or-admin gate. Despite the historical name, this allows BOTH the
 * "owner" and "admin" roles — Lumiverse's admin UIs (Operator, Spindle install,
 * Dropbox/Drive, etc.) all expect this behavior, so changing it would be a
 * silent privilege regression. For genuinely owner-only operations (cross-user
 * impersonation, destructive single-tenant actions), use `requireOwnerStrict`.
 */
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

/**
 * Strict owner-only gate. Use for operations that admins should NOT perform —
 * e.g. installing an extension into another user's context, resetting an
 * owner's password, or modifying owner-owned identity material.
 */
export async function requireOwnerStrict(c: Context, next: Next) {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (session.user.role !== "owner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  return next();
}
