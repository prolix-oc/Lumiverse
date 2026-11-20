#!/usr/bin/env bun
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CookieJar } from "jsdom";

// The shared scripts config includes DOM types; this script runs in Bun, whose
// WebSocket constructor also accepts HTTP headers for browser-session tests.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const binary = resolve(process.argv[2] || `dist/server/lumiverse-server-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
const temporary = mkdtempSync(join(tmpdir(), "lumiverse-server-smoke-"));
// No repository, Bun/Node/Git on PATH, inherited credentials, or user instance.
const env: Record<string, string> = { PATH: "", NO_COLOR: "1" };
for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "LANG"]) {
  if (process.env[key]) env[key] = process.env[key]!;
}
const argumentsForRun = ["--no-open", "--config-dir", join(temporary, "config"), "--cache-dir", join(temporary, "cache"), "--data-dir", join(temporary, "data")];
const unexpectedEnv = "OWNER_PASSWORD=unexpected-autoload-password\nPORT=1\n";
await Bun.write(join(temporary, ".env"), unexpectedEnv);
let server: Bun.Subprocess | undefined;
let output = "";

function launch(args: string[]) {
  const child = Bun.spawn([binary, ...argumentsForRun, ...args], { cwd: temporary, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ipc() {} });
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) output = (output + decoder.decode(bytes, { stream: true })).slice(-128_000);
  };
  const drained = Promise.all([capture(child.stdout), capture(child.stderr)]);
  return { child, drained };
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`Server exited while waiting for ${label}.\n${output}`);
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.\n${output}`);
}

async function stop(viaIpc = process.platform === "win32"): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const child = server;
  if (viaIpc) child.send({ type: "lumiverse-shutdown" });
  else child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try { await child.exited; } finally { clearTimeout(timer); }
}

/** Respect browser cookie rules rather than manually forwarding rejected Secure cookies. */
async function browserSignIn(origin: string, username: string, password: string): Promise<HeadersInit> {
  const response = await fetch(origin + "/api/auth/sign-in/username", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  const jar = new CookieJar(undefined, { allowSecureOnLocal: false, prefixSecurity: "strict" });
  for (const cookie of response.headers.getSetCookie()) {
    assert.doesNotMatch(cookie, /;\s*Secure(?:;|$)/i, "A local HTTP session must not require a Secure cookie");
    await jar.setCookie(cookie, origin);
  }
  const cookie = await jar.getCookieString(origin);
  assert.ok(cookie, "The browser must retain the session cookie");
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  const session = await (await fetch(origin + "/api/auth/get-session", { headers })).json() as { user?: { username: string } };
  assert.equal(session.user?.username, username);
  assert.equal((await fetch(origin + "/api/v1/system/info", { headers })).status, 200, "Protected API must accept the browser session");
  await new Promise<void>((resolve, reject) => {
    const socket = new BunWebSocket(origin.replace(/^http/, "ws") + "/api/ws?heartbeat=1", { headers: { Cookie: cookie, Origin: origin } });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Cookie-authenticated WebSocket timed out")), 10_000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "heartbeat_ready") finish();
      else if (message.event === "AUTH_ERROR") finish(new Error("WebSocket rejected the browser session"));
    };
    socket.onerror = () => finish(new Error("Cookie-authenticated WebSocket failed"));
    socket.onclose = () => { if (!finished) finish(new Error("WebSocket closed before authenticating")); };
  });
  return headers;
}

try {
  const queried = Bun.spawn([binary, ...argumentsForRun, "--print-data-dir"], { cwd: temporary, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [queriedPath, queryError, queryExit] = await Promise.all([new Response(queried.stdout).text(), new Response(queried.stderr).text(), queried.exited]);
  assert.equal(queryExit, 0, queryError);
  assert.equal(JSON.parse(queriedPath), join(temporary, "data"));
  for (const name of ["config", "cache", "data"]) assert.equal(existsSync(join(temporary, name)), false, `A path query must not initialize ${name}`);
  console.log("[smoke] Offline data folder query without server startup or storage initialization: OK");

  const checked = launch(["--check"]);
  const checkTimer = setTimeout(() => checked.child.kill("SIGKILL"), 90_000);
  let checkExit: number;
  try { checkExit = await checked.child.exited; await checked.drained; }
  finally { clearTimeout(checkTimer); }
  assert.equal(checkExit, 0, output);
  assert.match(output, /All checks passed/);
  console.log("[smoke] Offline native libraries, workers, and database subprocess: OK");
  output = "";
  const launched = launch([]);
  server = launched.child;
  const link = await until(() => output.match(/Set up Lumiverse: (http:\/\/127\.0\.0\.1:\d+\/#\w+)/)?.[1], "first-run GUI");
  const setup = new URL(link);
  const token = setup.hash.slice(1);
  const setupHeaders = { "X-Lumiverse-Setup": token, Origin: setup.origin, "Content-Type": "application/json" };
  const setupHtml = await (await fetch(setup.origin)).text();
  assert.match(setupHtml, /Set up Lumiverse/);
  assert.doesNotMatch(setupHtml, /\\u(?:00b7|2013)/i, "Compiled setup must render Unicode rather than escape text");
  assert.equal((await fetch(setup.origin + "/api/defaults")).status, 403);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const password = randomBytes(20).toString("hex");
  const configured = await fetch(setup.origin + "/api/setup", { method: "POST", headers: setupHeaders,
    body: JSON.stringify({ username: "bundle_owner", password, dataDir: join(temporary, "data"), port, host: "127.0.0.1" }) });
  assert.equal(configured.status, 200, await configured.text());
  await until(() => output.includes("[bundle] Open Lumiverse:") ? true : undefined, "server readiness");
  const origin = `http://127.0.0.1:${port}`;
  const status = await (await fetch(setup.origin + "/api/status", { headers: setupHeaders })).json() as { state: string; url: string };
  assert.equal(status.state, "ready");
  assert.equal(status.url, origin + "/");
  const index = await fetch(origin);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<html/i);
  const asset = html.match(/(?:src|href)="([^"<>]*\/assets\/[^"<>]+\.(?:js|css))"/)?.[1];
  assert.ok(asset, "Frontend HTML must reference a bundled JS or CSS asset");
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
  const headers = await browserSignIn(origin, "bundle_owner", password);
  await browserSignIn(`http://localhost:${port}`, "bundle_owner", password);
  const info = await fetch(origin + "/api/v1/system/info", { headers });
  assert.equal(info.status, 200);
  assert.equal((await info.json() as { backend: { distribution: string } }).backend.distribution, "bundled");
  const docs = await fetch(origin + "/api/v1/docs/catalog", { headers });
  assert.equal(docs.status, 200);
  assert.ok((await docs.json() as unknown[]).length > 0);
  const persona = await fetch(origin + "/api/v1/personas", { method: "POST", headers, body: JSON.stringify({ name: "Bundle smoke test" }) });
  assert.equal(persona.status, 201, await persona.text());
  assert.ok(!readFileSync(join(temporary, "config/server.json"), "utf8").includes(password));
  assert.equal(readFileSync(join(temporary, ".env"), "utf8"), unexpectedEnv, "A bundled launch must leave an unrelated working-directory .env untouched");
  console.log("[smoke] GUI setup, sign-in, frontend assets, documentation, and API write: OK");
  await stop();
  await launched.drained;
  assert.match(output, /\[Shutdown\] Cleanup complete/);
  output = "";
  const restarted = launch([]);
  server = restarted.child;
  await until(() => output.includes("[bundle] Open Lumiverse:") ? true : undefined, "configured restart");
  assert.ok(!output.includes("Set up Lumiverse:"), "A configured instance must not repeat setup");
  assert.equal((await fetch(origin)).status, 200);
  await stop(true);
  await restarted.drained;
  assert.match(output, /\[Shutdown\] Cleanup complete/);
  console.log("[smoke] Graceful shutdown and restart with saved settings: OK");

  // Exercise the same private callbacks used by Rust, with no setup HTTP server.
  output = "";
  const channelToken = randomBytes(32).toString("hex");
  const frames: Array<{ type: string; id?: string; success?: boolean; error?: string; data?: unknown; status?: { state: string; port: number } }> = [];
  let buffer = "";
  const nativeArgs = [...argumentsForRun, "--desktop", "--config-dir", join(temporary, "native-config"), "--data-dir", join(temporary, "native-data")];
  const nativeLaunch = () => {
    const child = Bun.spawn([binary, ...nativeArgs], { cwd: temporary, env: { ...env, LUMIVERSE_DESKTOP_CHANNEL_TOKEN: channelToken }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    server = child;
    const drain = async (stream: ReadableStream<Uint8Array>, protocol: boolean) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const text = decoder.decode(bytes, { stream: true });
        output = (output + text).slice(-128_000);
        if (!protocol) continue;
        buffer += text;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.startsWith("\x1e")) {
            const frame = JSON.parse(line.slice(1));
            assert.equal(frame.token, channelToken);
            frames.push(frame);
          }
        }
      }
    };
    return { child, drained: Promise.all([drain(child.stdout, true), drain(child.stderr, false)]) };
  };
  let native = nativeLaunch();
  const callback = async (type: string, payload?: unknown) => {
    const id = randomBytes(8).toString("hex");
    native.child.stdin.write(JSON.stringify({ id, type, payload }) + "\n");
    await native.child.stdin.flush();
    return until(() => frames.find((frame) => frame.id === id), `native ${type} callback`, 15_000);
  };
  await until(() => frames.some((frame) => frame.type === "setup") ? true : undefined, "native setup request");
  assert.equal((await callback("defaults")).success, true);
  const nativeSettings = { username: "native_owner", password, dataDir: join(temporary, "native-data"), port, host: "127.0.0.1" };
  assert.equal((await callback("configure", { ...nativeSettings, password: "short" })).success, false);
  assert.equal((await callback("configure", nativeSettings)).success, true);
  await until(() => frames.find((frame) => frame.status?.state === "running"), "native server readiness");
  assert.ok(!output.includes("Set up Lumiverse:"), "Native setup must not open a browser listener");
  assert.ok(!output.includes(password), "Setup callbacks must not log the password");
  assert.equal((await fetch(origin)).status, 200);
  await browserSignIn(`http://localhost:${port}`, "native_owner", password);
  assert.equal((await callback("shutdown")).success, true);
  assert.equal(await native.child.exited, 0);
  await native.drained;
  assert.match(output, /\[Shutdown\] Cleanup complete/);
  frames.length = 0; output = "";
  native = nativeLaunch();
  await until(() => frames.find((frame) => frame.status?.state === "running"), "native configured restart");
  assert.ok(!frames.some((frame) => frame.type === "setup"));
  // A native parent disappearing closes stdin. Its server must exit too.
  native.child.stdin.end();
  const exitTimer = setTimeout(() => native.child.kill("SIGKILL"), 25_000);
  try { assert.equal(await native.child.exited, 0); } finally { clearTimeout(exitTimer); }
  await native.drained;
  console.log("[smoke] Native setup callbacks, hashed credentials, restart, and parent-disconnect cleanup: OK");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stop();
  rmSync(temporary, { recursive: true, force: true });
}
