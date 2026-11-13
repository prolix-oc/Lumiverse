#!/usr/bin/env bun
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const HELP = `Serve a built Zensical site (no dependencies beyond Bun).

  bun --no-env-file scripts/serve-docs.ts --root <site-directory> [options]

  --root       Required build output containing index.html
  --host       Bind address (default: 127.0.0.1; use 0.0.0.0 for containers)
  --port       Listen port (default: 8000)
  --base-path  URL prefix, e.g. /guides/ (default: /)
  --help       Show this help
`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
};

export function normalizeBasePath(value = "/"): string {
  if (value === "/") return value;
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(value)) {
    throw new Error("--base-path must be a path such as / or /guides/.");
  }
  return value.endsWith("/") ? value : `${value}/`;
}

export function parseOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    root: { type: "string" }, host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8000" }, "base-path": { type: "string", default: "/" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) return null;
  if (!values.root) throw new Error("--root is required; point it at the built site directory.");
  if (!/^\d+$/.test(values.port!) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  if (values.host !== "localhost" && !isIP(values.host!)) {
    throw new Error("--host must be a bind IP address or localhost.");
  }
  return { root: values.root, host: values.host!, port: Number(values.port), basePath: normalizeBasePath(values["base-path"]) };
}

/** The publisher owns the site directory. Reject every symlink and special file. */
async function openFile(root: string, parts: string[]) {
  let path = root;
  let info;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    info = await lstat(path);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return null;
  }
  if (!info?.isFile()) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    // Check the opened inode and canonical path as well as the lexical path.
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || await realpath(path) !== path) {
      await handle.close();
      return null;
    }
    return { handle, info: opened, path };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function text(res: ServerResponse, req: IncomingMessage, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

export async function createDocsServer(options: { root: string; basePath?: string }) {
  const root = await realpath(resolve(options.root));
  const basePath = normalizeBasePath(options.basePath);
  const index = await openFile(root, ["index.html"]);
  if (!index) throw new Error("The site root must contain a regular index.html; build the docs first.");
  await index.handle.close();

  async function serve(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Keep Zensical's inline bootstrapping, search workers, and fonts working.
    res.setHeader("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Connection", "close");
      return text(res, req, 405, "Method Not Allowed\n");
    }
    if (req.headers["transfer-encoding"] || (req.headers["content-length"] && req.headers["content-length"] !== "0")) {
      res.setHeader("Connection", "close");
      return text(res, req, 400, "Bad Request\n");
    }

    // Parse the origin-form target directly: URL() would normalize away dot segments.
    const target = req.url ?? "";
    const question = target.indexOf("?");
    const rawPath = question < 0 ? target : target.slice(0, question);
    const query = question < 0 ? "" : target.slice(question);
    let pathname: string;
    try { pathname = decodeURIComponent(rawPath); }
    catch { return text(res, req, 400, "Bad Request\n"); }
    if (!pathname.startsWith("/") || pathname.includes("//") || /[\\\x00-\x1f\x7f]/.test(pathname)) {
      return text(res, req, 400, "Bad Request\n");
    }
    const parts = pathname.split("/").filter(Boolean);
    if (parts.some((part) => part.startsWith("."))) return text(res, req, 404, "Not Found\n");

    const redirect = (location: string) => {
      res.writeHead(308, { Location: location + query, "Content-Length": "0" });
      res.end();
    };
    if (basePath !== "/" && pathname === basePath.slice(0, -1)) return redirect(basePath);
    if (!pathname.startsWith(basePath)) return text(res, req, 404, "Not Found\n");
    const siteParts = pathname.slice(basePath.length).split("/").filter(Boolean);
    let file: Awaited<ReturnType<typeof openFile>> = null;
    let status = 200;
    try {
      // Trying index.html first handles directory URLs without ever listing them.
      file = await openFile(root, [...siteParts, "index.html"]);
      if (file && !pathname.endsWith("/")) {
        await file.handle.close();
        return redirect(`/${parts.map(encodeURIComponent).join("/")}/`);
      }
    } catch (error) { if (!isMissing(error)) throw error; }
    if (!file && !pathname.endsWith("/")) {
      try { file = await openFile(root, siteParts); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    if (!file) {
      status = 404;
      try { file = await openFile(root, ["404.html"]); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (!file) return text(res, req, 404, "Not Found\n");
    }

    const { handle, info, path } = file;
    try {
      if (status === 200) {
        const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        res.setHeader("ETag", etag);
        res.setHeader("Last-Modified", info.mtime.toUTCString());
        const tags = req.headers["if-none-match"];
        const modified = req.headers["if-modified-since"];
        const unchanged = tags !== undefined
          ? tags.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag.slice(2))
          : modified !== undefined && Math.floor(info.mtimeMs / 1000) * 1000 <= Date.parse(modified);
        if (unchanged) { res.writeHead(304); res.end(); return; }
      }
      res.writeHead(status, { "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "Content-Length": info.size });
      if (req.method === "HEAD") { res.end(); return; }
      await pipeline(handle.createReadStream({ autoClose: false }), res);
    } finally { await handle.close(); }
  }

  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5_000 }, (req, res) => {
    void serve(req, res).catch((error) => {
      if (res.destroyed) return;
      console.error("Docs request failed:", error);
      if (res.headersSent) res.destroy();
      else { res.removeHeader("ETag"); res.removeHeader("Last-Modified"); res.setHeader("Cache-Control", "no-store"); text(res, req, 500, "Internal Server Error\n"); }
    });
  });
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1_000;
  server.setTimeout(30_000, (socket) => socket.destroy());
  return server;
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (!options) console.log(HELP);
    else {
      const server = await createDocsServer(options);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
      });
      const host = options.host.includes(":") ? `[${options.host}]` : options.host;
      console.log(`Serving ${resolve(options.root)} at http://${host}:${options.port}${options.basePath}`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        server.close();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
