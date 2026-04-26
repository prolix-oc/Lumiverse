import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { verifyPassword } from "../crypto/password";
import { rateLimit } from "../middleware/rate-limit";
import { getDb } from "../db/connection";
import * as managerSvc from "../spindle/manager.service";
import { PRIVILEGED_PERMISSIONS } from "../spindle/manager.service";
import * as bulkUpdateSvc from "../spindle/bulk-update.service";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import * as lifecycle from "../spindle/lifecycle";
import { toolRegistry } from "../spindle/tool-registry";
import {
  getEphemeralPoolOverview,
  getEphemeralPoolConfig,
  updateEphemeralPoolConfig,
} from "../spindle/ephemeral-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const app = new Hono();

function getViewer(c: any): { userId: string; role: string } {
  const session = c.get("session");
  return {
    userId: session?.user?.id || "",
    role: session?.user?.role || "user",
  };
}

async function getVisibleExtension(c: any, id: string | undefined): Promise<ExtensionInfo | null> {
  if (!id) return null;
  const viewer = getViewer(c);
  return managerSvc.getExtensionForUser(id, viewer.userId, viewer.role);
}

function canManageExtension(c: any, ext: ExtensionInfo): boolean {
  const viewer = getViewer(c);
  return managerSvc.canManageExtension(ext, viewer.userId, viewer.role);
}

// GET /api/v1/spindle — List all extensions with status + viewer privilege
app.get("/", async (c) => {
  const viewer = getViewer(c);
  const extensions = (await managerSvc.listForUser(viewer.userId, viewer.role)).map((ext) => ({
    ...ext,
    status: lifecycle.isRunning(ext.id)
      ? "running"
      : ext.enabled
        ? "stopped"
        : "stopped",
  }));
  const isPrivileged = viewer.role === "owner" || viewer.role === "admin";
  return c.json({ extensions, isPrivileged });
});

// GET /api/v1/spindle/ephemeral/overview — Admin overview with reservations
app.get("/ephemeral/overview", requireOwner, async (c) => {
  return c.json(await getEphemeralPoolOverview({ includeReservations: true }));
});

// GET /api/v1/spindle/ephemeral/overview/me — User-facing pool overview
app.get("/ephemeral/overview/me", async (c) => {
  const viewer = getViewer(c);
  const overview = await getEphemeralPoolOverview({ includeReservations: false });
  const visibleIds = new Set(
    (await managerSvc.listForUser(viewer.userId, viewer.role)).map((ext) => ext.id)
  );
  const visibleExtensions = overview.extensions.filter((row) =>
    visibleIds.has(row.extensionId)
  );

  const visibleUsedBytes = visibleExtensions.reduce((sum, row) => sum + row.usedBytes, 0);
  const visibleReservedBytes = visibleExtensions.reduce(
    (sum, row) => sum + row.reservedBytes,
    0
  );

  return c.json({
    role: viewer.role,
    canEditPools: viewer.role === "owner" || viewer.role === "admin",
    global: {
      maxBytes: overview.global.maxBytes,
      usedBytes: visibleUsedBytes,
      reservedBytes: visibleReservedBytes,
      availableBytes: Math.max(
        0,
        overview.global.maxBytes - visibleUsedBytes - visibleReservedBytes
      ),
    },
    extensions: visibleExtensions,
  });
});

// GET /api/v1/spindle/ephemeral/config — Effective pool config
app.get("/ephemeral/config", requireOwner, async (c) => {
  return c.json(await getEphemeralPoolConfig());
});

// Re-auth gate before scrypt-verifying the owner password — bound how often
// a single client can drive scrypt work even when authenticated.
const ephemeralReauthLimiter = rateLimit({
  bucket: "spindle-ephemeral-reauth",
  max: 5,
  windowMs: 5 * 60 * 1000,
  message: "Too many configuration attempts. Try again later.",
});

// PUT /api/v1/spindle/ephemeral/config — Update pool config (credential-gated)
app.put("/ephemeral/config", requireOwner, ephemeralReauthLimiter, async (c) => {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return c.json({ error: "Invalid credentials" }, 403);
    }

    // Verify against the owner's hashed password in the account table
    const session = c.get("session");
    const account = getDb()
      .query('SELECT password FROM account WHERE userId = ? AND providerId = ?')
      .get(session.user.id, "credential") as { password: string } | null;

    if (!account) {
      return c.json({ error: "Invalid credentials" }, 403);
    }

    const valid = await verifyPassword({ hash: account.password, password });
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 403);
    }

    const next = await updateEphemeralPoolConfig({
      globalMaxBytes: body.globalMaxBytes,
      extensionDefaultMaxBytes: body.extensionDefaultMaxBytes,
      extensionMaxOverrides: body.extensionMaxOverrides,
      reservationTtlMs: body.reservationTtlMs,
    });

    return c.json(next);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to update config" }, 400);
  }
});

// POST /api/v1/spindle/branches — List branches from a remote GitHub URL (pre-install)
app.post("/branches", requireOwner, async (c) => {
  try {
    const body = await c.req.json();
    if (!body.github_url) {
      return c.json({ error: "github_url is required" }, 400);
    }
    const branches = managerSvc.listRemoteBranches(body.github_url);
    return c.json({ branches });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/install — Install from GitHub URL (admin/owner only)
app.post("/install", requireOwner, async (c) => {
  const viewer = getViewer(c);
  if (!viewer.userId) {
    return c.json({ error: "Unable to resolve user identity" }, 401);
  }

  try {
    const body = await c.req.json();
    if (!body.github_url) {
      return c.json({ error: "github_url is required" }, 400);
    }

    const requestedScope =
      typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "";
    const installScope = requestedScope === "user" ? "user" : "operator";
    const installedByUserId =
      installScope === "user"
        ? (typeof body.user_id === "string" && body.user_id.trim() ? body.user_id.trim() : viewer.userId)
        : null;
    const branch =
      typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      operation: "installing",
      name: body.github_url,
    });

    const ext = await managerSvc.install(body.github_url, {
      installScope,
      installedByUserId,
      branch,
    });

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "installed",
      name: ext.name,
    });

    return c.json(ext, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/import-local — Import extensions from local extensions dir
app.post("/import-local", requireOwner, async (c) => {
  try {
    const result = await managerSvc.importLocalExtensions();
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/update-all — Git pull + rebuild every extension the
// caller can manage, sequentially, in a background task. Returns immediately
// (HTTP 202). Progress streams via SPINDLE_BULK_UPDATE_PROGRESS / _COMPLETE
// WS events; per-extension status streams via SPINDLE_EXTENSION_STATUS.
app.post("/update-all", async (c) => {
  try {
    const viewer = getViewer(c);
    if (!viewer.userId) {
      return c.json({ error: "Unable to resolve user identity" }, 401);
    }
    const isPrivileged = viewer.role === "owner" || viewer.role === "admin";
    const result = await bulkUpdateSvc.updateAllExtensions({
      userId: viewer.userId,
      isPrivileged,
    });
    return c.json({ started: true, total: result.total }, 202);
  } catch (err: any) {
    const msg = err?.message || "Failed to start bulk update";
    const status = msg.includes("already running") ? 409 : 400;
    return c.json({ error: msg }, status);
  }
});

// POST /api/v1/spindle/:id/update — Git pull + rebuild
app.post("/:id/update", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "updating",
      name: ext.name,
    });

    // Stop if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }

    await managerSvc.update(ext.identifier);

    // Restart if was enabled
    if (ext.enabled) {
      await lifecycle.startExtension(ext.id);
    }

    // Re-fetch so the returned status reflects the post-restart state
    const finalExt = await managerSvc.getExtension(ext.id);
    const result = finalExt ?? ext;

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "updated",
      name: ext.name,
    });

    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// DELETE /api/v1/spindle/:id — Remove extension
app.delete("/:id", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "removing",
      name: ext.name,
    });

    // Stop if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }

    managerSvc.remove(ext.identifier);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "removed",
      name: ext.name,
    });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/enable — Enable + start worker (admin/owner only)
app.post("/:id/enable", requireOwner, async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "enabling",
      name: ext.name,
    });

    managerSvc.enable(ext.identifier);
    await lifecycle.startExtension(ext.id);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "enabled",
      name: ext.name,
    });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/disable — Disable + stop worker
app.post("/:id/disable", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "disabling",
      name: ext.name,
    });

    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }
    managerSvc.disable(ext.identifier);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "disabled",
      name: ext.name,
    });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/restart — Restart worker (stop + start)
app.post("/:id/restart", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    if (!ext.enabled) return c.json({ error: "Extension is not enabled" }, 400);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "restarting",
      name: ext.name,
    });

    await lifecycle.restartExtension(ext.id);

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "restarted",
      name: ext.name,
    });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/:id/permissions — Get requested + granted permissions
app.get("/:id/permissions", async (c) => {
  const ext = await getVisibleExtension(c, c.req.param("id"));
  if (!ext) return c.json({ error: "Not found" }, 404);

  return c.json({
    requested: ext.permissions,
    granted: ext.granted_permissions,
  });
});

// POST /api/v1/spindle/:id/permissions — Grant/revoke permissions
app.post("/:id/permissions", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json();
    const viewer = getViewer(c);
    const isPrivileged = viewer.role === "owner" || viewer.role === "admin";

    if (body.grant) {
      const privilegedRequested = (body.grant as string[]).filter((p) => PRIVILEGED_PERMISSIONS.has(p));
      if (privilegedRequested.length > 0 && !isPrivileged) {
        return c.json({
          error: `These permissions require admin approval: ${privilegedRequested.join(", ")}`,
        }, 403);
      }
      for (const perm of body.grant) {
        managerSvc.grantPermission(ext.identifier, perm);
      }
    }
    if (body.revoke) {
      for (const perm of body.revoke) {
        managerSvc.revokePermission(ext.identifier, perm);
      }
    }

    const updated = await managerSvc.getExtension(ext.id);
    const allGranted = updated?.granted_permissions ?? [];

    // Hot-apply permission changes to the running worker (no restart needed)
    if (lifecycle.isRunning(ext.id)) {
      if (body.grant) {
        for (const perm of body.grant) {
          lifecycle.notifyPermissionChanged(ext.id, perm, true, allGranted);
        }
      }
      if (body.revoke) {
        for (const perm of body.revoke) {
          lifecycle.notifyPermissionChanged(ext.id, perm, false, allGranted);
        }
      }
    }

    return c.json({
      requested: updated?.permissions,
      granted: allGranted,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/:id/manifest — Get parsed spindle.json
app.get("/:id/manifest", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);

    const manifest = await managerSvc.getManifest(ext.identifier);
    return c.json(manifest);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/:id/branches — List branches for an installed extension
app.get("/:id/branches", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);

    const result = managerSvc.getBranches(ext.identifier);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/switch-branch — Switch to a different branch
app.post("/:id/switch-branch", async (c) => {
  try {
    const ext = await getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json();
    if (!body.branch || typeof body.branch !== "string") {
      return c.json({ error: "branch is required" }, 400);
    }

    // Stop if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }

    await managerSvc.switchBranch(ext.identifier, body.branch);

    // Restart if was enabled
    if (ext.enabled) {
      await lifecycle.startExtension(ext.id);
    }

    // Re-fetch so the returned status reflects the post-restart state
    const finalExt = await managerSvc.getExtension(ext.id);
    const result = finalExt ?? ext;

    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/tools — List all registered tools
app.get("/tools", async (c) => {
  const viewer = getViewer(c);
  const visibleIds = new Set(
    (await managerSvc.listForUser(viewer.userId, viewer.role)).map((ext) => ext.id)
  );
  return c.json(toolRegistry.getTools().filter((tool) => visibleIds.has(tool.extension_id)));
});

// GET /api/v1/spindle/:id/frontend — Serve the extension's frontend bundle
app.get("/:id/frontend", async (c) => {
  const ext = await getVisibleExtension(c, c.req.param("id"));
  if (!ext) return c.json({ error: "Not found" }, 404);

  const bundlePath = await managerSvc.getFrontendBundlePath(ext.identifier);
  if (!bundlePath || !(await Bun.file(bundlePath).exists())) {
    return c.json({ error: "No frontend bundle" }, 404);
  }

  const content = await Bun.file(bundlePath).text();
  return new Response(content, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none';",
    },
  });
});

export { app as spindleRoutes };
