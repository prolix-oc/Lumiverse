import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { env } from "../env";
import * as managerSvc from "../spindle/manager.service";
import { PRIVILEGED_PERMISSIONS } from "../spindle/manager.service";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import * as lifecycle from "../spindle/lifecycle";
import { toolRegistry } from "../spindle/tool-registry";
import {
  getEphemeralPoolOverview,
  getEphemeralPoolConfig,
  updateEphemeralPoolConfig,
} from "../spindle/ephemeral-pool.service";
import { readFileSync, existsSync } from "fs";

const app = new Hono();

function getViewer(c: any): { userId: string; role: string } {
  const session = c.get("session");
  return {
    userId: session?.user?.id || "",
    role: session?.user?.role || "user",
  };
}

function getVisibleExtension(c: any, id: string | undefined): ExtensionInfo | null {
  if (!id) return null;
  const viewer = getViewer(c);
  return managerSvc.getExtensionForUser(id, viewer.userId, viewer.role);
}

function canManageExtension(c: any, ext: ExtensionInfo): boolean {
  const viewer = getViewer(c);
  return managerSvc.canManageExtension(ext, viewer.userId, viewer.role);
}

// GET /api/v1/spindle — List all extensions with status + viewer privilege
app.get("/", (c) => {
  const viewer = getViewer(c);
  const extensions = managerSvc.listForUser(viewer.userId, viewer.role).map((ext) => ({
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
app.get("/ephemeral/overview", requireOwner, (c) => {
  return c.json(getEphemeralPoolOverview({ includeReservations: true }));
});

// GET /api/v1/spindle/ephemeral/overview/me — User-facing pool overview
app.get("/ephemeral/overview/me", (c) => {
  const viewer = getViewer(c);
  const overview = getEphemeralPoolOverview({ includeReservations: false });
  const visibleIds = new Set(
    managerSvc.listForUser(viewer.userId, viewer.role).map((ext) => ext.id)
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
app.get("/ephemeral/config", requireOwner, (c) => {
  return c.json(getEphemeralPoolConfig());
});

// PUT /api/v1/spindle/ephemeral/config — Update pool config (credential-gated)
app.put("/ephemeral/config", requireOwner, async (c) => {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password !== env.ownerPassword) {
      return c.json({ error: "Invalid credentials" }, 403);
    }

    const next = updateEphemeralPoolConfig({
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

    const ext = await managerSvc.install(body.github_url, {
      installScope,
      installedByUserId,
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

// POST /api/v1/spindle/:id/update — Git pull + rebuild
app.post("/:id/update", async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    // Stop if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }

    const updated = await managerSvc.update(ext.identifier);

    // Restart if was enabled
    if (ext.enabled) {
      await lifecycle.startExtension(ext.id);
    }

    return c.json(updated);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// DELETE /api/v1/spindle/:id — Remove extension
app.delete("/:id", async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    // Stop if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }

    managerSvc.remove(ext.identifier);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/enable — Enable + start worker (admin/owner only)
app.post("/:id/enable", requireOwner, async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    managerSvc.enable(ext.identifier);
    await lifecycle.startExtension(ext.id);

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/disable — Disable + stop worker
app.post("/:id/disable", async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.stopExtension(ext.id);
    }
    managerSvc.disable(ext.identifier);

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /api/v1/spindle/:id/restart — Restart worker (stop + start)
app.post("/:id/restart", async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);
    if (!canManageExtension(c, ext)) return c.json({ error: "Forbidden" }, 403);

    if (!ext.enabled) return c.json({ error: "Extension is not enabled" }, 400);

    await lifecycle.restartExtension(ext.id);

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/:id/permissions — Get requested + granted permissions
app.get("/:id/permissions", (c) => {
  const ext = getVisibleExtension(c, c.req.param("id"));
  if (!ext) return c.json({ error: "Not found" }, 404);

  return c.json({
    requested: ext.permissions,
    granted: ext.granted_permissions,
  });
});

// POST /api/v1/spindle/:id/permissions — Grant/revoke permissions
app.post("/:id/permissions", async (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
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

    // Restart to apply permission changes if running
    if (lifecycle.isRunning(ext.id)) {
      await lifecycle.restartExtension(ext.id);
    }

    const updated = managerSvc.getExtension(ext.id);
    return c.json({
      requested: updated?.permissions,
      granted: updated?.granted_permissions,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/:id/manifest — Get parsed spindle.json
app.get("/:id/manifest", (c) => {
  try {
    const ext = getVisibleExtension(c, c.req.param("id"));
    if (!ext) return c.json({ error: "Not found" }, 404);

    const manifest = managerSvc.getManifest(ext.identifier);
    return c.json(manifest);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /api/v1/spindle/tools — List all registered tools
app.get("/tools", (c) => {
  const viewer = getViewer(c);
  const visibleIds = new Set(
    managerSvc.listForUser(viewer.userId, viewer.role).map((ext) => ext.id)
  );
  return c.json(toolRegistry.getTools().filter((tool) => visibleIds.has(tool.extension_id)));
});

// GET /api/v1/spindle/:id/frontend — Serve the extension's frontend bundle
app.get("/:id/frontend", (c) => {
  const ext = getVisibleExtension(c, c.req.param("id"));
  if (!ext) return c.json({ error: "Not found" }, 404);

  const bundlePath = managerSvc.getFrontendBundlePath(ext.identifier);
  if (!bundlePath || !existsSync(bundlePath)) {
    return c.json({ error: "No frontend bundle" }, 404);
  }

  const content = readFileSync(bundlePath, "utf-8");
  return new Response(content, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none';",
    },
  });
});

export { app as spindleRoutes };
