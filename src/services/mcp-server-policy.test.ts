import { describe, expect, test } from "bun:test";
import { validateMcpServerCreateInput } from "./mcp-server-policy";

describe("MCP server input policy", () => {
  test("accepts HTTP servers and normalizes their public fields", () => {
    expect(validateMcpServerCreateInput({
      name: "  Weather  ",
      transport_type: "streamable_http",
      url: "https://mcp.example.test/v1",
      headers: { Authorization: "Bearer secret" },
    })).toEqual({
      name: "Weather",
      transport_type: "streamable_http",
      url: "https://mcp.example.test/v1",
      headers: { Authorization: "Bearer secret" },
    });
  });

  test("rejects non-HTTP URL schemes before they reach a transport", () => {
    expect(() => validateMcpServerCreateInput({
      name: "Local file",
      transport_type: "sse",
      url: "file:///etc/passwd",
    })).toThrow("must use http or https");
  });

  test("reuses the stdio launch guard", () => {
    expect(() => validateMcpServerCreateInput({
      name: "Inline process",
      transport_type: "stdio",
      command: "node",
      args: ["--eval", "process.exit()"],
    })).toThrow("cannot use inline-code argument");
  });

  test("rejects non-string secret values", () => {
    expect(() => validateMcpServerCreateInput({
      name: "Bad headers",
      transport_type: "streamable_http",
      url: "https://mcp.example.test",
      headers: { Authorization: 123 },
    })).toThrow("only string values");
  });
});
