import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { WorkerHost } from "./worker-host";

const originalDataDir = env.dataDir;
let directory: string;
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80]);
const maxReadBytes = 100 * 1024 * 1024;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "spindle-image-bytes-"));
  env.dataDir = directory;
  await mkdir(join(directory, "images"));
  initDatabase(":memory:");
  getDb().run("CREATE TABLE images (id TEXT PRIMARY KEY, user_id TEXT, filename TEXT, mime_type TEXT)");
  for (const [id, user] of [["original", "alice"], ["private", "bob"], ["missing-file", "alice"], ["at-limit", "alice"], ["large", "alice"]]) {
    getDb().run("INSERT INTO images VALUES (?, ?, ?, ?)", [id!, user!, `${id}.png`, "image/png"]);
  }
  await Bun.write(join(directory, "images", "original.png"), bytes);
  await Bun.write(join(directory, "images", "private.png"), bytes);
  await Bun.write(join(directory, "images", "original_thumb_sm.webp"), "different thumbnail");
  await Bun.write(join(directory, "images", "at-limit.png"), bytes);
  await truncate(join(directory, "images", "at-limit.png"), maxReadBytes);
  await Bun.write(join(directory, "images", "large.png"), "");
  await truncate(join(directory, "images", "large.png"), maxReadBytes + 1);
});
afterAll(async () => {
  closeDatabase();
  env.dataDir = originalDataDir;
  await rm(directory, { recursive: true, force: true });
});

function invoke(imageId: string, options: { scope?: "user" | "operator"; permitted?: boolean; userId?: string } = {}): Promise<any> {
  const host = new WorkerHost("image-bytes-test", {
    identifier: "image-bytes-test", name: "Image bytes test",
  } as SpindleManifest, {
    id: "image-bytes-test", identifier: "image-bytes-test", name: "Image bytes test",
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: options.scope ?? "user", installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = permission => options.permitted !== false && permission === "images";
  return new Promise(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ type: "images_read_binary", requestId: "request", imageId, userId: options.userId });
  });
}

test("image binary RPC returns exact original bytes without thumbnail conversion", async () => {
  const response = await invoke("original");
  expect(response.error).toBeUndefined();
  expect(response.result).toBeInstanceOf(Uint8Array);
  expect(response.result).toEqual(bytes);
});

test("image binary RPC accepts an original of exactly 100 MiB", async () => {
  const response = await invoke("at-limit");
  expect(response.error).toBeUndefined();
  expect(response.result).toBeInstanceOf(Uint8Array);
  expect(response.result.byteLength).toBe(maxReadBytes);
  expect(response.result.subarray(0, bytes.byteLength)).toEqual(bytes);
  expect(response.result[maxReadBytes - 1]).toBe(0);
});

test("image binary RPC enforces permission, owner isolation, and operator scope", async () => {
  expect((await invoke("original", { permitted: false })).error).toContain("images");
  expect((await invoke("private")).error).toBe("Image not found");
  expect((await invoke("private", { userId: "bob" })).error).toBe("Image not found");
  expect((await invoke("original", { scope: "operator" })).error).toContain("userId is required");
  expect((await invoke("private", { scope: "operator", userId: "bob" })).result).toEqual(bytes);
});

test("image binary RPC rejects missing assets, paths, and oversized originals", async () => {
  expect((await invoke("unknown")).error).toBe("Image not found");
  expect((await invoke("missing-file")).error).toBe("Image not found");
  expect((await invoke("../original.png")).error).toBe("Image not found");
  expect((await invoke("large")).error).toBe("Image exceeds the 100 MiB binary read limit");
});
