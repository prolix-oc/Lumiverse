import { Hono } from "hono";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { requireOwner } from "../auth/middleware";
import { getDb } from "../db/connection";
import { scanSTData } from "../migration/st-reader";
import {
  executeMigration,
  isMigrationRunning,
  getActiveMigration,
  getLastMigration,
} from "../migration/st-migration.service";
import type { FileConnectionConfig, FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";
import { createFileSystem, withFileSystem, getAvailableConnectionTypes } from "../file-connections/factory";

const app = new Hono();

// All routes require owner or admin role
app.use("/*", requireOwner);

// ─── GET /connection-types — available file connection providers ─────────────

app.get("/connection-types", async (c) => {
  const types = await getAvailableConnectionTypes();
  return c.json({ types });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const localFs = new LocalFileSystem();

function parseConnectionConfig(body: any): FileConnectionConfig {
  if (!body.connection || body.connection.type === "local") {
    return { type: "local" };
  }
  return body.connection as FileConnectionConfig;
}

// ─── POST /test-connection — test a remote file connection ──────────────────

app.post("/test-connection", async (c) => {
  const body = await c.req.json();
  const config = body.connection as FileConnectionConfig | undefined;

  if (!config || config.type === "local") {
    return c.json({ success: true, type: "local" });
  }

  let fs: FileSystem | null = null;
  try {
    fs = await createFileSystem(config);
    await fs.connect();

    // Verify we can list the root / share
    const testPath = body.path || (config.type === "smb" ? "/" : "/");
    const canList = await fs.exists(testPath);

    return c.json({
      success: true,
      type: config.type,
      canAccess: canList,
    });
  } catch (err: any) {
    return c.json({
      success: false,
      type: config.type,
      error: err.message,
    }, 400);
  } finally {
    if (fs) {
      try { await fs.disconnect(); } catch { /* ignore */ }
    }
  }
});

// ─── GET /browse — filesystem directory browser ─────────────────────────────

app.get("/browse", async (c) => {
  const rawPath = c.req.query("path") || homedir();
  const connectionJson = c.req.query("connection");

  let config: FileConnectionConfig = { type: "local" };
  if (connectionJson) {
    try {
      config = JSON.parse(connectionJson);
    } catch {
      return c.json({ error: "Invalid connection JSON" }, 400);
    }
  }

  if (config.type === "local") {
    // Local browsing — same logic as before
    const resolved = resolve(rawPath);
    try {
      const stat = await localFs.stat(resolved);
      if (!stat.isDirectory) {
        return c.json({ error: "Not a directory" }, 400);
      }
    } catch (err: any) {
      return c.json({ error: "Cannot access path" }, 500);
    }

    try {
      const allEntries = await localFs.readdir(resolved);
      const entries = allEntries
        .filter((e) => e.isDirectory && !e.name.startsWith("."))
        .map((e) => ({ name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = resolved === "/" ? null : dirname(resolved);
      return c.json({ path: resolved, parent, entries });
    } catch {
      return c.json({ error: "Failed to read directory" }, 500);
    }
  }

  // Remote browsing
  let fs: FileSystem | null = null;
  try {
    fs = await createFileSystem(config);
    await fs.connect();

    const targetPath = rawPath || "/";

    const allEntries = await fs.readdir(targetPath);
    const entries = allEntries
      .filter((e) => e.isDirectory && !e.name.startsWith("."))
      .map((e) => ({ name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = targetPath === "/" ? null : fs.dirname(targetPath);
    return c.json({ path: targetPath, parent, entries });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to browse remote directory" }, 500);
  } finally {
    if (fs) {
      try { await fs.disconnect(); } catch { /* ignore */ }
    }
  }
});

// ─── POST /validate — validate SillyTavern installation ────────────────────

app.post("/validate", async (c) => {
  const body = await c.req.json();
  const rawPath = body.path;
  const config = parseConnectionConfig(body);

  if (!rawPath || typeof rawPath !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const doValidation = async (fs: FileSystem) => {
    const resolved = config.type === "local" ? resolve(rawPath) : rawPath;

    if (!(await fs.exists(resolved))) {
      return { valid: false, error: "Directory does not exist" };
    }

    // Check for multi-user layout: data/{user}/characters/
    const dataDir = fs.join(resolved, "data");
    if (await fs.exists(dataDir)) {
      try {
        const entries = await fs.readdir(dataDir);
        const userDirs: string[] = [];

        for (const entry of entries) {
          if (entry.name.startsWith(".") || !entry.isDirectory) continue;
          const charsDir = fs.join(dataDir, entry.name, "characters");
          if (await fs.exists(charsDir)) {
            userDirs.push(entry.name);
          }
        }

        if (userDirs.length > 0) {
          return {
            valid: true,
            basePath: resolved,
            stUsers: userDirs,
            layout: "multi-user",
          };
        }
      } catch {
        // fall through to legacy check
      }
    }

    // Check for legacy layout: public/characters/
    const legacyChars = fs.join(resolved, "public", "characters");
    if (await fs.exists(legacyChars)) {
      return {
        valid: true,
        basePath: resolved,
        stUsers: [],
        layout: "legacy",
      };
    }

    return { valid: false, error: "No SillyTavern data found at this path" };
  };

  if (config.type === "local") {
    const result = await doValidation(localFs);
    return c.json(result, result.valid === false && result.error ? 200 : 200);
  }

  try {
    const result = await withFileSystem(config, doValidation);
    return c.json(result);
  } catch (err: any) {
    return c.json({ valid: false, error: err.message }, 200);
  }
});

// ─── POST /scan — preview available data ────────────────────────────────────

app.post("/scan", async (c) => {
  const body = await c.req.json();
  const dataDir = body.dataDir;
  const config = parseConnectionConfig(body);

  if (!dataDir || typeof dataDir !== "string") {
    return c.json({ error: "dataDir is required" }, 400);
  }

  if (config.type === "local") {
    const resolved = resolve(dataDir);
    if (!(await localFs.exists(resolved))) {
      return c.json({ error: "Directory does not exist" }, 404);
    }
    const counts = await scanSTData(resolved, localFs);
    return c.json(counts);
  }

  try {
    const counts = await withFileSystem(config, async (fs) => {
      if (!(await fs.exists(dataDir))) {
        throw new Error("Directory does not exist");
      }
      return scanSTData(dataDir, fs);
    });
    return c.json(counts);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── POST /execute — start migration ────────────────────────────────────────

app.post("/execute", async (c) => {
  if (isMigrationRunning()) {
    return c.json({ error: "A migration is already in progress" }, 409);
  }

  const body = await c.req.json();
  const { dataDir, targetUserId, scope } = body;
  const config = parseConnectionConfig(body);

  if (!dataDir || typeof dataDir !== "string") {
    return c.json({ error: "dataDir is required" }, 400);
  }
  if (!targetUserId || typeof targetUserId !== "string") {
    return c.json({ error: "targetUserId is required" }, 400);
  }
  if (!scope || typeof scope !== "object") {
    return c.json({ error: "scope is required" }, 400);
  }

  // For local, resolve and verify path
  const effectiveDataDir = config.type === "local" ? resolve(dataDir) : dataDir;

  if (config.type === "local" && !(await localFs.exists(effectiveDataDir))) {
    return c.json({ error: "Data directory does not exist" }, 404);
  }

  // Permission enforcement
  const callerUserId = c.get("userId");
  const callerRole = c.get("session")?.user?.role;

  if (callerRole === "owner") {
    // Owner can only migrate to themselves
    if (targetUserId !== callerUserId) {
      return c.json({ error: "Owner can only migrate to their own account" }, 403);
    }
  } else if (callerRole === "admin") {
    // Admin can migrate to self or user-role accounts
    if (targetUserId !== callerUserId) {
      const targetUser = getDb()
        .query('SELECT id, role FROM "user" WHERE id = ?')
        .get(targetUserId) as { id: string; role: string } | null;

      if (!targetUser) {
        return c.json({ error: "Target user not found" }, 404);
      }
      if (targetUser.role === "owner" || targetUser.role === "admin") {
        return c.json({ error: "Admins can only migrate to their own account or user-role accounts" }, 403);
      }
    }
  }

  const migrationId = crypto.randomUUID();

  // For remote connections, create and connect the FileSystem before handing
  // it off to the async migration. The migration service will disconnect it
  // when done (in the finally block).
  let fs: FileSystem = localFs;
  if (config.type !== "local") {
    try {
      fs = await createFileSystem(config);
      await fs.connect();
    } catch (err: any) {
      return c.json({ error: `Failed to connect: ${err.message}` }, 400);
    }
  }

  // Run migration asynchronously — return immediately
  executeMigration(migrationId, callerUserId, targetUserId, effectiveDataDir, {
    characters: !!scope.characters,
    worldBooks: !!scope.worldBooks,
    personas: !!scope.personas,
    chats: !!scope.chats,
    groupChats: !!scope.groupChats,
  }, fs);

  return c.json({ migrationId }, 202);
});

// ─── GET /status — check migration status ───────────────────────────────────

app.get("/status", (c) => {
  const active = getActiveMigration();
  if (active) {
    return c.json({
      status: "running",
      migrationId: active.migrationId,
      phase: active.phase,
      startedAt: active.startedAt,
    });
  }

  const last = getLastMigration();
  if (last) {
    return c.json({
      status: last.error ? "failed" : "completed",
      migrationId: last.migrationId,
      phase: last.phase,
      startedAt: last.startedAt,
      results: last.results,
      error: last.error,
    });
  }

  return c.json({ status: "idle" });
});

export { app as stMigrationRoutes };
