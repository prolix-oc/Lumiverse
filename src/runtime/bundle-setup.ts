import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import { hashPassword } from "../crypto/password";
import { writeOwnerCredentials } from "../crypto/credentials";
import { BUNDLE_SETUP_PAGE } from "./bundle-setup-page";
import { validateSettings, type BundledServerSettings } from "./bundle";

export function hasConfiguredOwner(dataDir: string): boolean {
  if (existsSync(join(dataDir, "owner.credentials"))) return true;
  const path = join(dataDir, "lumiverse.db");
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get()) return false;
    return Boolean(db.query('SELECT 1 FROM "user" LIMIT 1').get());
  } finally { db.close(); }
}

export function writeBundleSettings(path: string, settings: BundledServerSettings): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function validateOwner(username: unknown, password: unknown): asserts username is string {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.]{3,32}$/.test(username)) throw new Error("Username must contain 3–32 letters, numbers, underscores, or dots.");
  if (typeof password !== "string" || password.length < 8 || password.length > 1024) throw new Error("Password must contain 8–1024 characters.");
}

/** GUI and unattended provisioning share the same exclusive account creation. */
export async function configureBundleOwner(settings: BundledServerSettings, settingsPath: string, username: unknown, password: unknown): Promise<void> {
  validateOwner(username, password);
  if (hasConfiguredOwner(settings.dataDir)) throw new Error("This folder already contains a Lumiverse account. Choose a new data folder, or launch with --data-dir pointing to the existing instance.");
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const lock = join(settings.dataDir, ".bundle-setup.lock");
  // If this fails, another setup owns the lock; never remove its lock in finally.
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    if (hasConfiguredOwner(settings.dataDir)) throw new Error("This data folder has already been configured.");
    const passwordHash = await hashPassword(password as string);
    const credentials = join(settings.dataDir, "owner.credentials");
    await writeOwnerCredentials(credentials, username, passwordHash);
    try { writeBundleSettings(settingsPath, settings); }
    catch (error) { rmSync(credentials, { force: true }); throw error; }
  } finally { rmSync(lock, { force: true }); }
}

export interface BundleSetup {
  url: string;
  settings: Promise<BundledServerSettings>;
  ready(url: string): void;
  failed(message: string): void;
  stop(): void;
}

/** This listener is loopback-only and every API request requires a per-launch secret. */
export function startBundleSetup(defaults: BundledServerSettings, settingsPath: string): BundleSetup {
  const token = randomBytes(32).toString("hex");
  let state: "setup" | "starting" | "ready" | "failed" = "setup";
  let serverUrl = "";
  let failure = "";
  let saving = false;
  let finish!: (settings: BundledServerSettings) => void;
  const settings = new Promise<BundledServerSettings>((resolveSettings) => { finish = resolveSettings; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8192,
    async fetch(request, server) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return json({ error: "Invalid setup host." }, 403);
      if (request.headers.has("origin") && request.headers.get("origin") !== origin) return json({ error: "Invalid setup origin." }, 403);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(BUNDLE_SETUP_PAGE, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" } });
      }
      const supplied = Buffer.from(request.headers.get("x-lumiverse-setup") || "");
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: "Invalid setup token." }, 403);
      if (request.method === "GET" && url.pathname === "/api/defaults") return json(defaults);
      if (request.method === "GET" && url.pathname === "/api/status") return json({ state, url: serverUrl, error: failure });
      if (request.method !== "POST" || url.pathname !== "/api/setup") return json({ error: "Not found." }, 404);
      if (state !== "setup" || saving) return json({ error: "Setup has already started." }, 409);
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Expected JSON." }, 415);
      saving = true;
      try {
        const input = await request.json() as Record<string, unknown>;
        if (input.host !== "127.0.0.1" && input.host !== "::") throw new Error("Choose local access or network access.");
        if (typeof input.dataDir !== "string" || !isAbsolute(input.dataDir)) throw new Error("Choose an absolute path for the data folder.");
        const selected = validateSettings({ format: 1, dataDir: input.dataDir, port: input.port, host: input.host });
        await configureBundleOwner(selected, settingsPath, input.username, input.password);
        state = "starting";
        finish(selected);
        return json({ ok: true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Setup failed." }, 400);
      } finally {
        saving = false;
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/#${token}`, settings,
    ready(url) { state = "ready"; serverUrl = url; setTimeout(() => server.stop(true), 60_000).unref(); },
    failed(message) { state = "failed"; failure = message; },
    stop() { server.stop(true); },
  };
}

export function openBundleBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  try {
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  } catch { /* The printed URL also works on hosts without a graphical session. */ }
}
