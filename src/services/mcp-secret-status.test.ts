import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as secretsSvc from "./secrets.service";
import { withReadableMcpSecretStatus } from "./mcp-servers.service";
import type { McpServerProfile } from "../types/mcp-server";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

function profile(): McpServerProfile {
  return {
    id: "mcp-1",
    name: "Test MCP",
    transport_type: "stdio",
    url: "",
    command: "test",
    args: [],
    env: { 0: "TOKEN" },
    has_headers: true,
    is_enabled: true,
    auto_connect: true,
    metadata: {},
    last_connected_at: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("MCP secret status", () => {
  test("clears stale header and env indicators when their secrets are unreadable", async () => {
    spies.push(spyOn(secretsSvc, "getSecretForStatus").mockResolvedValue(null));

    const result = await withReadableMcpSecretStatus("user-1", profile());

    expect(result.has_headers).toBe(false);
    expect(result.env).toEqual({});
  });

  test("preserves indicators when both encrypted values are readable", async () => {
    spies.push(spyOn(secretsSvc, "getSecretForStatus").mockResolvedValue("{\"TOKEN\":\"value\"}"));
    const original = profile();

    await expect(withReadableMcpSecretStatus("user-1", original)).resolves.toBe(original);
  });
});
