import { Hono } from "hono";
import { cpus, totalmem, freemem, platform, arch, release, hostname } from "os";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const app = new Hono();

function getBackendVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getGitInfo(): { branch: string; commit: string } {
  const projectRoot = join(import.meta.dir, "../..");
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim();
    const commit = execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

function getDiskUsage(): { total: number; used: number } | null {
  try {
    const { statfsSync } = require("fs");
    const stat = statfsSync("/");
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, used: total - free };
  } catch {
    return null;
  }
}

app.get("/info", (c) => {
  const cpu = cpus();
  const disk = getDiskUsage();

  return c.json({
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
      hostname: hostname(),
    },
    cpu: {
      model: cpu[0]?.model ?? "unknown",
      cores: cpu.length,
    },
    memory: {
      total: totalmem(),
      free: freemem(),
    },
    disk,
    backend: {
      version: getBackendVersion(),
      runtime: `Bun ${Bun.version}`,
    },
    git: getGitInfo(),
  });
});

export { app as systemRoutes };
