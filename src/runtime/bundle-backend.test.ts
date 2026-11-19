import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnBundleBackend, type BundleBackend } from "./bundle-backend";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Backend control timed out")), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const platform of ["win32", ...(process.platform === "win32" ? [] : [process.platform])]) test(`bundled ${platform} backend reports ready and shuts down over its control channel`, async () => {
  const ready = Promise.withResolvers<unknown>();
  const errors: string[] = [];
  let backend: BundleBackend | undefined;
  try {
    backend = spawnBundleBackend({
      cmd: [process.execPath, join(import.meta.dir, "test-fixtures/bundle-backend-child.ts")],
      env: { ...process.env }, desktop: true, serve: true, platform,
      onMessage: ready.resolve, onError: (error) => errors.push(error), onDisconnect() {},
    });
    expect(await within(ready.promise)).toEqual({ type: "bundle-ready", usesBunIpc: platform !== "win32" });
    expect(backend.send({ type: "shutdown" })).toBe(true);
    expect(await within(backend.exited)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    backend?.close();
    backend?.kill("SIGKILL");
    if (backend) await backend.exited;
  }
});

test("bundled socket backend exits when its owning launcher disconnects", async () => {
  const ready = Promise.withResolvers<unknown>();
  let backend: BundleBackend | undefined;
  try {
    backend = spawnBundleBackend({
      cmd: [process.execPath, join(import.meta.dir, "test-fixtures/bundle-backend-child.ts")],
      env: { ...process.env }, desktop: true, serve: true, platform: "win32",
      onMessage: ready.resolve, onError: ready.reject, onDisconnect() {},
    });
    await within(ready.promise);
    backend.close();
    expect(await within(backend.exited)).toBe(0);
  } finally {
    backend?.close();
    backend?.kill("SIGKILL");
    if (backend) await backend.exited;
  }
});
