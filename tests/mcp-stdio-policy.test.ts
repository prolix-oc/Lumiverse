import { describe, expect, test } from "bun:test";
import { assertStdioLaunchAllowed } from "../src/services/mcp-stdio-policy";

describe("assertStdioLaunchAllowed", () => {
  test("allows direct script-based MCP launches", () => {
    expect(() => assertStdioLaunchAllowed("node", ["./server.js"])).not.toThrow();
    expect(() => assertStdioLaunchAllowed("python3", ["./server.py"])).not.toThrow();
  });

  test("rejects unallowlisted commands", () => {
    expect(() => assertStdioLaunchAllowed("bash", ["-lc", "id"])).toThrow("allowlist");
  });

  test("rejects package runners by default", () => {
    expect(() => assertStdioLaunchAllowed("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])).toThrow("allowlist");
    expect(() => assertStdioLaunchAllowed("uvx", ["mcp-server-fetch"])).toThrow("allowlist");
  });

  test("rejects inline code flags for interpreters", () => {
    expect(() => assertStdioLaunchAllowed("node", ["-e", "process.exit()"])).toThrow("inline-code");
    expect(() => assertStdioLaunchAllowed("python3", ["-c", "print(1)"])).toThrow("inline-code");
    expect(() => assertStdioLaunchAllowed("deno", ["eval", "console.log(1)"])).toThrow("inline-code");
  });
});
