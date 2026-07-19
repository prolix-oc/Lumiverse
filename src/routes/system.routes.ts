import { Hono } from "hono";
import { cpus, totalmem, freemem, platform, arch, release, hostname } from "os";
import { join } from "path";
import { getGitMetadata } from "../utils/git-metadata";

const app = new Hono();

async function getBackendVersion(): Promise<string> {
  try {
    const raw = await Bun.file(join(import.meta.dir, "../../package.json")).text();
    const pkg = JSON.parse(raw);
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getGitInfo(): { branch: string; commit: string } {
  const { branch, commit } = getGitMetadata();
  return { branch, commit };
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

app.get("/info", async (c) => {
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
      version: await getBackendVersion(),
      runtime: `Bun ${Bun.version}`,
    },
    git: getGitInfo(),
  });
});

export { app as systemRoutes };
