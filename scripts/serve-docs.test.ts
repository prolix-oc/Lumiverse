import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDocsServer, parseOptions } from "./serve-docs";

let directory: string;
let root: string;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lumiverse-docs-"));
  root = join(directory, "site");
  await mkdir(join(root, "chapter"), { recursive: true });
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "empty"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "index.html"), "<h1>Docs</h1>");
  await writeFile(join(root, "chapter", "index.html"), "<h1>Chapter</h1>");
  await writeFile(join(root, "404.html"), "<h1>Missing page</h1>");
  await writeFile(join(root, "assets", "app.js"), "console.log('docs');");
  await writeFile(join(root, "assets", "search.json"), '{"docs":[]}');
  await writeFile(join(root, "assets", "font.woff2"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(root, ".env"), "SECRET=do-not-serve");
  await writeFile(join(root, ".git", "config"), "private git configuration");
  await writeFile(join(directory, "secret.txt"), "outside-secret");
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

async function start(basePath = "/") {
  const server = await createDocsServer({ root, basePath });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener");
  return address.port;
}

// node:http preserves hostile raw paths that fetch/URL would normalize first.
async function get(port: number, path = "/", options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; bytes: Buffer }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body: bytes.toString(), bytes });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("serves public proxy hostnames, security headers, and HEAD metadata", async () => {
  const port = await start();
  const response = await get(port, "/", { headers: { Host: "docs.lumiverse.chat", "X-Forwarded-Host": "attacker.example" } });
  expect(response.status).toBe(200);
  expect(response.body).toBe("<h1>Docs</h1>");
  expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("DENY");
  expect(response.headers["content-security-policy"]).toContain("base-uri 'self'");
  const head = await get(port, "/", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body).toBe("");
  expect(head.headers["content-length"]).toBe(response.headers["content-length"]);
});

test("preserves the guides prefix and query in local-only slash redirects", async () => {
  const port = await start("/guides/");
  const base = await get(port, "/guides?theme=dark", { headers: { Host: "attacker.example" } });
  expect(base.status).toBe(308);
  expect(base.headers.location).toBe("/guides/?theme=dark");
  const nested = await get(port, "/guides/chapter?q=hello%20world");
  expect(nested.headers.location).toBe("/guides/chapter/?q=hello%20world");
  expect((await get(port, "/guides/chapter/")).body).toBe("<h1>Chapter</h1>");
  expect((await get(port, "/guides/")).status).toBe(200);
  for (const path of ["/", "/chapter/", "/guides-other/", "/guides-other/chapter/"]) {
    expect((await get(port, path)).status).toBe(404);
  }
});

test("serves scripts, search data, and fonts with correct MIME and bytes", async () => {
  const port = await start();
  expect((await get(port, "/assets/app.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
  expect((await get(port, "/assets/search.json")).headers["content-type"]).toBe("application/json; charset=utf-8");
  const font = await get(port, "/assets/font.woff2");
  expect(font.headers["content-type"]).toBe("font/woff2");
  expect(font.bytes).toEqual(Buffer.from([0, 1, 2, 255]));
});

test("missing paths keep 404 status and never expose a directory listing", async () => {
  const port = await start();
  for (const path of ["/missing", "/empty/", "/assets/", "/index.html/"]) {
    const response = await get(port, path);
    expect(response.status).toBe(404);
    expect(response.body).toBe("<h1>Missing page</h1>");
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  await rm(join(root, "404.html"));
  expect((await get(port, "/missing")).body).toBe("Not Found\n");
  expect((await get(port, "/missing", { method: "HEAD" })).body).toBe("");
});

test("rejects raw, encoded, and nested traversal and hidden paths", async () => {
  const port = await start();
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/chapter/../../secret.txt", "/chapter/%2e%2e/%2e%2e/secret.txt", "/%2eenv", "/.git/config", "/assets/../index.html", "/%2e%2e%2fsecret.txt"]) {
    const response = await get(port, path);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("secret");
  }
  for (const path of ["//evil.example/", "/%2f/evil.example", "/%5c..%5csecret.txt", "/%00", "/%0a", "/%zz"]) {
    const response = await get(port, path);
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
  }
});

test("rejects file and directory symlinks, even when their targets are inside the site", async () => {
  await symlink(join(directory, "secret.txt"), join(root, "escape.txt"));
  await symlink(directory, join(root, "escape-dir"));
  await symlink(join(root, "index.html"), join(root, "alias.html"));
  await symlink(join(root, "chapter"), join(root, "alias-dir"));
  const port = await start();
  for (const path of ["/escape.txt", "/escape-dir/secret.txt", "/alias.html", "/alias-dir/", "/alias-dir"]) {
    const response = await get(port, path);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("outside-secret");
  }
});

test.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
  execFileSync("mkfifo", [join(root, "pipe")]);
  const port = await start();
  expect((await get(port, "/pipe")).status).toBe(404);
  expect((await get(port, "/pipe/")).status).toBe(404);
});

test("rejects write methods and request bodies without modifying files", async () => {
  const port = await start();
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await get(port, "/index.html", { method, body: "replace" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
  }
  const withBody = await get(port, "/", { headers: { "Content-Length": "7" }, body: "replace" });
  expect(withBody.status).toBe(400);
  expect((await get(port)).body).toBe("<h1>Docs</h1>");
});

test("revalidates unchanged content and sees rebuilt files without restarting", async () => {
  const port = await start();
  const first = await get(port);
  expect(first.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
  const etag = first.headers.etag as string;
  expect((await get(port, "/", { headers: { "If-None-Match": `"another", ${etag}` } })).status).toBe(304);
  expect((await get(port, "/", { headers: { "If-None-Match": etag.slice(2) } })).body).toBe("");
  expect((await get(port, "/", { headers: { "If-Modified-Since": first.headers["last-modified"] as string } })).status).toBe(304);
  expect((await get(port, "/", { headers: { "If-None-Match": '"different"', "If-Modified-Since": first.headers["last-modified"] as string } })).status).toBe(200);
  await writeFile(join(root, "index.html"), "<h1>New documentation</h1>");
  const rebuilt = await get(port, "/", { headers: { "If-None-Match": etag } });
  expect(rebuilt.status).toBe(200);
  expect(rebuilt.body).toBe("<h1>New documentation</h1>");
  expect(rebuilt.headers.etag).not.toBe(etag);
});

test("requires built output and validates CLI options", async () => {
  expect(parseOptions(["--help"])).toBeNull();
  expect(parseOptions(["--root", root])).toEqual({ root, host: "127.0.0.1", port: 8000, basePath: "/" });
  expect(parseOptions(["--root", root, "--base-path", "/guides"])?.basePath).toBe("/guides/");
  for (const args of [[], ["--root", root, "--port", "0"], ["--root", root, "--port", "65536"], ["--root", root, "--port", "1e3"], ["--root", root, "--base-path", "//evil"], ["--root", root, "--base-path", "/../"], ["--root", root, "--host", "https://example.com"], ["--root", root, "--unknown"]]) {
    expect(() => parseOptions(args)).toThrow();
  }
  await rm(join(root, "index.html"));
  await expect(createDocsServer({ root })).rejects.toThrow();
  await symlink(join(directory, "secret.txt"), join(root, "index.html"));
  await expect(createDocsServer({ root })).rejects.toThrow();
});
