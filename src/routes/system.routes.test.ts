import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import { env } from "../env";
import { systemRoutes } from "./system.routes";

const originalDataDir = env.dataDir;
let statfs: ReturnType<typeof spyOn<typeof fs, "statfsSync">>;

beforeEach(() => {
  env.dataDir = "/srv/Lumiverse/data";
  const disk = fs.statfsSync(import.meta.dir);
  statfs = spyOn(fs, "statfsSync").mockReturnValue({
    ...disk,
    bsize: 4096,
    blocks: 1000,
    bavail: 750,
  });
});
afterEach(() => {
  statfs.mockRestore();
  env.dataDir = originalDataDir;
});

function request(role: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: { id: "user-1", name: "Test user", email: "user@example.test", role },
      session: { id: "session-1", userId: "user-1", token: "test-token", expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  app.route("/system", systemRoutes);
  return app.request("/system/info");
}

test.each(["owner", "admin"])("%s diagnostics report the filesystem containing DATA_DIR", async (role) => {
  const response = await request(role);
  expect(response.status).toBe(200);
  expect((await response.json()).disk).toEqual({ total: 4096000, used: 1024000 });
  expect(statfs).toHaveBeenCalledWith("/srv/Lumiverse/data");
  expect(statfs).not.toHaveBeenCalledWith("/");
});

test("diagnostics stay available when the data filesystem cannot be queried", async () => {
  statfs.mockImplementation(() => { throw new Error("statfs unavailable"); });
  const response = await request("owner");
  expect(response.status).toBe(200);
  const info = await response.json();
  expect(info.disk).toBeNull();
  expect(info.backend.version).not.toBe("unknown");
});

test("ordinary users do not receive disk or other operator diagnostics", async () => {
  const response = await request("user");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    disk: null,
    os: { release: "", hostname: "" },
    cpu: { model: "", cores: 0 },
    memory: { total: 0, free: 0 },
    git: { branch: "", commit: "" },
  });
});
