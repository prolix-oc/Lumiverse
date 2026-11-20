// Disposable loopback fixture: real SQLite, routes, worker runtime and host dispatcher.
import { Hono } from "hono";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initDatabase, closeDatabase, getDb } from "../../src/db/connection";
import * as characters from "../../src/services/characters.service";
import * as chats from "../../src/services/chats.service";
import { charactersRoutes } from "../../src/routes/characters.routes";
import { WorkerHost } from "../../src/spindle/worker-host";

const directory = process.argv[2];
if (!directory) throw new Error("A disposable directory is required");
initDatabase(":memory:");
getDb().exec(await Bun.file(new URL("../../src/db/baseline.sql", import.meta.url)).text());
const owner = "character-filter-test";
for (const id of [owner, "other-owner"]) {
  getDb().run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, 0, 0)', [id, id, `${id}@example.test`]);
}
const ordinary = characters.createCharacter(owner, { name: "Multiplayer Rooms" });
const mira = characters.createCharacter(owner, { name: "Mira" });
const flagged = characters.createCharacter(owner, { name: "System Rooms", extensions: { _lumiverse_library_hidden: true } });
const legacy = characters.createCharacter(owner, { name: "Multiplayer Rooms" });
const shadow = chats.createChat(owner, { character_id: legacy.id });
getDb().run("UPDATE chats SET metadata = ? WHERE id = ?", [JSON.stringify({ multiplayer: true, joined_room: { roomId: "legacy-room" } }), shadow.id]);
characters.createCharacter("other-owner", { name: "Foreign Rooms" });

const entry = join(directory, "extension.mjs");
await Bun.write(entry, `spindle.onFrontendMessage(async ({ id, method, options }) => {
  try {
    const result = method === 'get' ? await spindle.characters.get(options.id) : await spindle.characters.list(options);
    spindle.sendToFrontend({ id, result });
  } catch (error) { spindle.sendToFrontend({ id, error: error.message }); }
});`);
const manifest = { identifier: "character-filter-test", name: "Character filter test", permissions: ["characters"] };
const host = new WorkerHost("character-filter-test", manifest as any, {
  ...manifest, id: "character-filter-test", version: "0.0.0", granted_permissions: ["characters"],
  metadata: { install_scope: "user", installed_by_user_id: owner },
} as any);
const internal = host as any;
let granted = true;
internal.hasPermission = (permission: string) => granted && permission === "characters";
const pending = new Map<string, (value: unknown) => void>();
let resolveReady!: () => void;
const ready = new Promise<void>(resolve => { resolveReady = resolve; });
const worker = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../src/spindle/worker-runtime.ts")], {
  stdout: "ignore", stderr: "inherit", env: { ...process.env, DATA_DIR: directory },
  ipc(message: any, child) {
    if (message.message === "__worker_ready__") resolveReady();
    else if (message.type === "permissions_get_granted") child.send({ type: "response", requestId: message.requestId, result: ["characters"] });
    else if (message.type === "frontend_message") pending.get(message.payload.id)?.(message.payload);
    else internal.handleMessage(message);
  },
});
internal.runtime = { mode: "worker", pid: worker.pid, postMessage: (message: unknown) => worker.send(message), terminate: () => worker.kill() };
worker.send({ type: "init", manifest: { ...manifest, entry_backend: pathToFileURL(entry).href }, storagePath: directory });
await Promise.race([ready, Bun.sleep(10_000).then(() => { throw new Error("Worker startup timed out"); })]);

const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", owner); await next(); });
app.route("/api/v1/characters", charactersRoutes);
app.get("/client.js", () => new Response(Bun.file(join(directory, "client.js")), { headers: { "Content-Type": "text/javascript" } }));
app.get("/", c => c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<main><h1>Character filter regression fixture</h1><output id="status">ready</output></main>
<script type="module">import { charactersApi } from '/client.js'; window.hostCharacters = charactersApi;</script></body></html>`));
app.get("/fixture", c => c.json({ ordinary: ordinary.id, mira: mira.id, flagged: flagged.id, legacy: legacy.id }));
app.post("/permission", async c => { granted = (await c.req.json()).granted === true; return c.json({ granted }); });
app.post("/rpc", async c => {
  const input = await c.req.json();
  const id = crypto.randomUUID();
  return new Promise<Response>(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve(c.json({ error: "Worker RPC timed out" }, 504)); }, 5_000);
    pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(c.json(value)); });
    worker.send({ type: "frontend_message", userId: owner, payload: { id, ...input } });
  });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
process.on("SIGTERM", () => { server.stop(true); worker.kill(); closeDatabase(); process.exit(0); });
console.log(JSON.stringify({ url: server.url.href }));
