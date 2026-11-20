import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import {
  isAdvertisedMcpTool,
  toSpindleMcpServerDTO,
  toSpindleMcpStatus,
  WorkerHostMcpApi,
} from "./worker-host-mcp-api";

const DB_DIR = join(tmpdir(), "lumiverse-worker-host-mcp-api-test-");
const DB_PATH = join(DB_DIR, "test.db");

beforeAll(async () => {
  initDatabase(DB_PATH);
  await runMigrations(getDb());
  getDb().run(
    `INSERT OR IGNORE INTO "user" (id, name, email) VALUES
      ('alice', 'Alice', 'alice@example.test'),
      ('bob', 'Bob', 'bob@example.test')`,
  );
});

afterAll(() => {
  closeDatabase();
  rmSync(DB_DIR, { recursive: true, force: true });
});

afterEach(() => {
  getDb().run("DELETE FROM mcp_servers");
});

function invoke(
  permissions: string[],
  run: (api: WorkerHostMcpApi) => void,
  owner = "alice",
): Promise<{ result?: any; error?: string }> {
  return new Promise((resolve) => {
    const api = new WorkerHostMcpApi({
      hasPermission: (permission) => permissions.includes(permission),
      resolveEffectiveUserId: (userId) => userId || owner,
      enforceScopedUser: (userId) => {
        if (userId !== owner) throw new Error("Extension is user-scoped and cannot access this user context");
      },
      postResponse: resolve,
    });
    run(api);
  });
}

describe("Spindle MCP API", () => {
  test("only accepts currently advertised tool names and redacts transport errors", () => {
    const status = {
      id: "server-1",
      connected: false,
      tool_count: 1,
      tools: [{
        server_id: "server-1",
        server_name: "Remote",
        name: "search",
        description: "",
        input_schema: {},
      }],
      error: "connect ECONNREFUSED https://token@example.test/private",
    };
    expect(isAdvertisedMcpTool(status, "search")).toBe(true);
    expect(isAdvertisedMcpTool(status, "hidden_admin_tool")).toBe(false);
    expect(toSpindleMcpStatus(status).error).toBe("MCP connection failed");
  });

  test("never exposes connection locations, arguments, or secret values", () => {
    const dto = toSpindleMcpServerDTO({
      id: "server-1",
      name: "Private MCP",
      transport_type: "stdio",
      url: "https://internal.example.test",
      command: "node",
      args: ["/private/server.js"],
      env: { SECRET_TOKEN: "secret" },
      has_headers: true,
      is_enabled: true,
      auto_connect: false,
      metadata: {},
      last_connected_at: null,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    });

    expect(dto.env_keys).toEqual(["SECRET_TOKEN"]);
    expect(dto).not.toHaveProperty("url");
    expect(dto).not.toHaveProperty("command");
    expect(dto).not.toHaveProperty("args");
    expect(dto).not.toHaveProperty("env");
    expect(dto).not.toHaveProperty("metadata");
    expect(dto).not.toHaveProperty("last_error");
  });

  test("requires the separate create permission and defaults auto-connect off", async () => {
    const denied = await invoke(["mcp_servers"], (api) => api.handleCreate("denied", {
      name: "Remote",
      transport_type: "streamable_http",
      url: "https://mcp.example.test",
    }));
    expect(denied.error).toContain("mcp_servers.create");

    const created = await invoke(["mcp_servers.create"], (api) => api.handleCreate("created", {
      name: "Remote",
      transport_type: "streamable_http",
      url: "https://mcp.example.test",
    }));
    expect(created.error).toBeUndefined();
    expect(created.result.auto_connect).toBe(false);
    expect(created.result).not.toHaveProperty("url");
  });

  test("does not permit persistent auto-connect with create-only access", async () => {
    const response = await invoke(["mcp_servers.create"], (api) => api.handleCreate("created", {
      name: "Persistent remote",
      transport_type: "streamable_http",
      url: "https://mcp.example.test",
      auto_connect: true,
    }));
    expect(response.error).toContain("mcp_servers");
    expect(getDb().query("SELECT COUNT(*) AS count FROM mcp_servers").get()).toEqual({ count: 0 });
  });

  test("does not let a user-scoped extension cross user ownership", async () => {
    const response = await invoke(["mcp_servers"], (api) => api.handleList("list", 50, 0, "bob"));
    expect(response.error).toContain("cannot access this user context");
  });
});
