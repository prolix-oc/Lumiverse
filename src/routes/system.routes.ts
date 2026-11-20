import { Hono } from "hono";
import { cpus, totalmem, freemem, platform, arch, release, hostname } from "os";
import { join } from "path";
import { statfsSync } from "node:fs";
import { env } from "../env";
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
    const stat = statfsSync(env.dataDir);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, used: total - free };
  } catch {
    return null;
  }
}

app.get("/info", async (c) => {
  // Hostname, OS release, CPU, memory, disk and git details are operator
  // material — they fingerprint the machine. Regular (authenticated) users
  // only get what the Diagnostics panel genuinely needs to report a version
  // mismatch: app version, runtime, platform and arch. Redacted fields come
  // back as empty values so the response shape stays stable for the frontend.
  const role = c.get("session")?.user?.role;
  const privileged = role === "owner" || role === "admin";

  const cpu = cpus();
  const disk = getDiskUsage();

  return c.json({
    os: {
      platform: platform(),
      arch: arch(),
      release: privileged ? release() : "",
      hostname: privileged ? hostname() : "",
    },
    cpu: privileged
      ? { model: cpu[0]?.model ?? "unknown", cores: cpu.length }
      : { model: "", cores: 0 },
    memory: privileged
      ? { total: totalmem(), free: freemem() }
      : { total: 0, free: 0 },
    disk: privileged ? disk : null,
    backend: {
      version: await getBackendVersion(),
      runtime: `Bun ${Bun.version}`,
      distribution: process.env.LUMIVERSE_BUNDLE_ID ? "bundled" : "source",
    },
    git: privileged ? getGitInfo() : { branch: "", commit: "" },
  });
});

export { app as systemRoutes };
