import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingRemoteSnapshot } from "../src/remote-instance";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.skipIf(process.platform === "win32")("AppRun captures original unset, empty and spaced values before its inner launcher runs", () => {
  const root = mkdtempSync(join(tmpdir(), "lumiverse app run ")); roots.push(root);
  copyFileSync(new URL("../../scripts/appimage-apprun.sh", import.meta.url), join(root, "AppRun"));
  writeFileSync(join(root, "AppRun.lumiverse-inner"), `#!/usr/bin/env bash
set -eu
printf '%s\\0' "$LUMIVERSE_HOST_PATH" "$LUMIVERSE_HOST_LD_PRELOAD_SET" "$LUMIVERSE_HOST_LD_PRELOAD" "$LUMIVERSE_HOST_GDK_BACKEND_SET" "$LUMIVERSE_HOST_GTK_PATH" "$1"
`);
  chmodSync(join(root, "AppRun.lumiverse-inner"), 0o755);
  const env = { ...process.env, PATH: `/host with spaces:${process.env.PATH}`, LD_PRELOAD: "", GTK_PATH: "/user gtk path" };
  delete (env as NodeJS.ProcessEnv).GDK_BACKEND;
  const result = Bun.spawnSync(["bash", join(root, "AppRun"), "argument with spaces"], { env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().split("\0")).toEqual([env.PATH, "1", "", "0", "/user gtk path", "argument with spaces", ""]);
});

const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
const auth = main.slice(main.indexOf("function connectRemoteInstance():"), main.indexOf("async function disconnectRemoteInstance()"));
const executable = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(auth);
function authorization(options: { local?: boolean; menu?: () => Promise<void>; invoke?: (command: string, args: unknown) => Promise<unknown> } = {}) {
  const factory = new Function("invoke", "pendingRemoteSnapshot", "updateMenu", "persistRemoteIdentity", "alert", `
    let instanceConnection = { mode: "remote", origin: "https://example.com" };
    let remoteSnapshot = null, remoteAuthorizationId = null, remoteAuthorizationLastId = null, remoteAuthorizationLastOrigin = null, remoteAuthorizationTask = null;
    const frontendUrl = () => "https://example.com";
    ${executable}
    if (${!!options.local}) instanceConnection = { mode: "local" };
    return { connect: connectRemoteInstance, authorize: connectDesktopAuthorization, cancel: cancelRemoteAuthorization,
      snapshot: () => remoteSnapshot, id: () => remoteAuthorizationId };
  `);
  return factory(options.invoke ?? (async () => { throw new Error("native launch failed"); }), pendingRemoteSnapshot,
    options.menu ?? (async () => {}), async () => {}, async () => {}) as {
      connect(): Promise<void>; authorize(origin: string): Promise<void>; cancel(): Promise<void>; snapshot(): ReturnType<typeof pendingRemoteSnapshot> | null; id(): string | null;
    };
}
test("a menu failure before native sign-in still clears authorizing and permits retry", async () => {
  let calls = 0;
  const flow = authorization({ menu: async () => { if (++calls === 1) throw new Error("menu failed"); } });
  await expect(flow.connect()).rejects.toThrow("menu failed");
  expect(flow.snapshot()?.state).toBe("reauth_required");
  expect(flow.id()).toBeNull();
  await expect(flow.connect()).rejects.toThrow("native launch failed");
  expect(flow.snapshot()?.state).toBe("reauth_required");
});
test("cancellation invalidates the old result and a retry can complete", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const connected = { ...pendingRemoteSnapshot("https://example.com"), state: "connected", credentialPersisted: true };
  const flow = authorization({ invoke: async command => {
    if (command === "remote_instance_connect") return new Promise(resolve => { finish = resolve; });
    if (command === "remote_authorization_cancel") finish?.(connected);
    return null;
  } });
  const first = flow.connect();
  await Bun.sleep(0);
  await flow.cancel(); await first;
  expect(flow.snapshot()?.state).toBe("reauth_required");
  const second = flow.connect(); await Bun.sleep(0); finish?.(connected); await second;
  expect(flow.snapshot()?.state).toBe("connected");
});

test("local capture and presence authorization share retryable cleanup without changing remote status", async () => {
  let calls = 0;
  const flow = authorization({ local: true, invoke: async () => {
    if (++calls === 1) throw new Error("browser unavailable");
    return { ...pendingRemoteSnapshot("https://example.com"), state: "connected", credentialPersisted: true };
  } });
  await expect(flow.authorize("https://example.com")).rejects.toThrow("browser unavailable");
  expect(flow.id()).toBeNull();
  expect(flow.snapshot()).toBeNull();
  await flow.authorize("https://example.com");
  expect(calls).toBe(2);
  expect(flow.id()).toBeNull();
  expect(flow.snapshot()).toBeNull();
});
