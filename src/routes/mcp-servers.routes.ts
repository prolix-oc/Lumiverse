import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import * as svc from "../services/mcp-servers.service";
import { getMcpClientManager } from "../services/mcp-client-manager";
import { assertStdioLaunchAllowed } from "../services/mcp-stdio-policy";
import { parsePagination } from "../services/pagination";

const app = new Hono();

app.use("/*", requireOwner);

function touchesRuntimeConfig(input: Record<string, unknown>): boolean {
  return ["transport_type", "url", "command", "args", "headers", "env"].some((key) => key in input);
}

/** List MCP servers (paginated) */
app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listServers(userId, pagination));
});

/** Create MCP server */
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.transport_type) {
    return c.json({ error: "name and transport_type are required" }, 400);
  }
  const valid = ["streamable_http", "sse", "stdio"];
  if (!valid.includes(body.transport_type)) {
    return c.json({ error: `transport_type must be one of: ${valid.join(", ")}` }, 400);
  }
  if (body.transport_type === "stdio") {
    try {
      assertStdioLaunchAllowed(body.command, body.args || []);
    } catch (err: any) {
      return c.json({ error: err.message || "Invalid MCP stdio launch configuration" }, 400);
    }
  }
  const server = await svc.createServer(userId, body);
  return c.json(server, 201);
});

/** Get all server statuses */
app.get("/status", (c) => {
  const userId = c.get("userId");
  const manager = getMcpClientManager();
  const servers = svc.getEnabledServers(userId);
  const statuses = servers.map((s) => {
    const live = manager.getStatus(userId, s.id);
    return live || {
      id: s.id,
      connected: false,
      tool_count: 0,
      tools: [],
      error: s.last_error || undefined,
    };
  });
  return c.json({ servers: statuses });
});

/** Get MCP server by ID */
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  return c.json(server);
});

/** Update MCP server */
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (body.transport_type) {
    const valid = ["streamable_http", "sse", "stdio"];
    if (!valid.includes(body.transport_type)) {
      return c.json({ error: `transport_type must be one of: ${valid.join(", ")}` }, 400);
    }
  }
  const manager = getMcpClientManager();
  const serverId = c.req.param("id");
  const existing = svc.getServer(userId, serverId);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const transportType = body.transport_type || existing.transport_type;
  if (transportType === "stdio") {
    try {
      assertStdioLaunchAllowed(
        body.command !== undefined ? body.command : existing.command,
        body.args !== undefined ? body.args : existing.args,
      );
    } catch (err: any) {
      return c.json({ error: err.message || "Invalid MCP stdio launch configuration" }, 400);
    }
  }
  const wasConnected = !!manager.getStatus(userId, serverId);
  const server = await svc.updateServer(userId, serverId, body);
  if (!server) return c.json({ error: "Not found" }, 404);

  manager.updateCachedProfile(userId, server);

  if (!server.is_enabled) {
    await manager.disconnect(userId, server.id);
    return c.json(server);
  }

  if (wasConnected && touchesRuntimeConfig(body)) {
    await manager.reconnect(userId, server);
  }

  return c.json(server);
});

/** Delete MCP server */
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Disconnect before deleting
  await getMcpClientManager().disconnect(userId, id);
  if (!(await svc.deleteServer(userId, id))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

/** Connect to MCP server */
app.post("/:id/connect", async (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  const status = await getMcpClientManager().connect(userId, server);
  return c.json(status);
});

/** Disconnect from MCP server */
app.post("/:id/disconnect", async (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  await getMcpClientManager().disconnect(userId, server.id);
  return c.json({ success: true });
});

/** Reconnect MCP server */
app.post("/:id/reconnect", async (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  const status = await getMcpClientManager().reconnect(userId, server);
  return c.json(status);
});

/** Get connection status + tools */
app.get("/:id/status", (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  const live = getMcpClientManager().getStatus(userId, server.id);
  return c.json(live || {
    id: server.id,
    connected: false,
    tool_count: 0,
    tools: [],
    error: server.last_error || undefined,
  });
});

/** Test connection (connect, list tools, disconnect) */
app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);

  const manager = getMcpClientManager();
  const live = manager.getStatus(userId, server.id);
  if (live) {
    return c.json({
      success: true,
      message: `Already connected — ${live.tool_count} tool(s) discovered`,
      tools: live.tools,
    });
  }

  const status = await manager.connect(userId, server);

  // If test-only, disconnect after listing tools
  if (status.connected) {
    await manager.disconnect(userId, server.id);
  }

  return c.json({
    success: status.connected,
    message: status.connected
      ? `Connected successfully — ${status.tool_count} tool(s) discovered`
      : `Connection failed: ${status.error}`,
    tools: status.tools,
  });
});

/** List discovered tools for a connected server */
app.get("/:id/tools", (c) => {
  const userId = c.get("userId");
  const server = svc.getServer(userId, c.req.param("id"));
  if (!server) return c.json({ error: "Not found" }, 404);
  const live = getMcpClientManager().getStatus(userId, server.id);
  return c.json({ tools: live?.tools || [] });
});

export { app as mcpServersRoutes };
