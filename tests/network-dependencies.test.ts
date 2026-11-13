import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/bun";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("HTTP dependency safety boundaries", () => {
  test("rejects an oversized unknown-length body before running the handler", async () => {
    let handled = false;
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 4 }));
    app.post("/", (c) => {
      handled = true;
      // An early response must not bypass the upload limit.
      return c.text("accepted");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    const response = await app.request("http://localhost/", { method: "POST", body });
    expect(response.status).toBe(413);
    expect(handled).toBe(false);
  });

  test("preserves an allowed unknown-length body for downstream parsing", async () => {
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 4 }));
    app.post("/", async (c) => c.text(await c.req.text()));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test"));
        controller.close();
      },
    });

    const response = await app.request("http://localhost/", { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test");
  });

  test("static files accept GET and HEAD without answering POST requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-http-static-"));
    writeFileSync(join(root, "index.html"), "frontend fixture");
    const app = new Hono();
    app.use("*", serveStatic({ root }));
    try {
      const get = await app.request("http://localhost/index.html");
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("frontend fixture");
      const head = await app.request("http://localhost/index.html", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await app.request("http://localhost/index.html", { method: "POST" });
      expect(post.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MCP does not forward custom credentials or a tool body to another origin", async () => {
    const calls: { url: string; redirect?: RequestRedirect; secret: string | null }[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.test/api"), {
      requestInit: { headers: { "X-Api-Key": "test-credential" } },
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          redirect: init?.redirect,
          secret: new Headers(init?.headers).get("X-Api-Key"),
        });
        return new Response(null, { status: 307, headers: { location: "https://other.example.test/api" } });
      },
    });
    await transport.start();
    try {
      await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test" } }))
        .rejects.toThrow("redirect");
      expect(calls).toEqual([{
        url: "https://mcp.example.test/api",
        redirect: "manual",
        secret: "test-credential",
      }]);
    } finally {
      await transport.close();
    }
  });

  test("MCP still follows a same-origin endpoint redirect", async () => {
    const calls: string[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.test/api"), {
      fetch: async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? new Response(null, { status: 307, headers: { location: "/final" } })
          : new Response(null, { status: 202 });
      },
    });
    await transport.start();
    try {
      await transport.send({ jsonrpc: "2.0", method: "notifications/ping" });
      expect(calls).toEqual(["https://mcp.example.test/api", "https://mcp.example.test/final"]);
    } finally {
      await transport.close();
    }
  });
});
