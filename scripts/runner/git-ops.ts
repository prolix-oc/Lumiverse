import { join } from "path";
import { existsSync, rmSync } from "fs";
import { runGit, getUpstreamRef, getCurrentBranch } from "./lib/git.js";
import { PROJECT_ROOT, AVAILABLE_BRANCHES } from "./lib/constants.js";

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}

function log(text: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] [runner] ${text}`);
}

/**
 * Run git fetch and check how many commits we're behind upstream.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const remote = runGit("remote");
  if (!remote.ok || !remote.out) {
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  // Async git fetch
  const fetchProc = Bun.spawn(["git", "fetch", "--quiet"], {
    cwd: PROJECT_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  const fetchCode = await fetchProc.exited;
  if (fetchCode !== 0) {
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  const branch = getCurrentBranch();
  if (!branch) return { available: false, commitsBehind: 0, latestMessage: "" };

  const upstream = getUpstreamRef(branch);
  if (!upstream) return { available: false, commitsBehind: 0, latestMessage: "" };

  const revList = runGit("rev-list", "--count", `HEAD..${upstream}`);
  if (!revList.ok) return { available: false, commitsBehind: 0, latestMessage: "" };

  const behind = parseInt(revList.out, 10);
  if (behind > 0) {
    const logMsg = runGit("log", "--format=%s", "-1", upstream);
    const latestMessage = logMsg.ok ? logMsg.out : "";
    log(`Update available: ${behind} commit${behind > 1 ? "s" : ""} behind`);
    return { available: true, commitsBehind: behind, latestMessage };
  }

  return { available: false, commitsBehind: 0, latestMessage: "" };
}

/**
 * Apply update: stash → clear cache → delete dist → pull → install → build → restart
 */
export async function applyUpdate(
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>
): Promise<void> {
  log("Preparing update...");

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", "lumiverse-runner-auto-stash");
  }

  // Stop server before destructive operations
  await stopServer();

  // Clear Bun transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist to prevent git conflicts
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendDistDir = join(frontendDir, "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Pull latest
  log("Pulling latest changes...");
  const pullProc = Bun.spawn(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pullOut = await new Response(pullProc.stdout).text();
  const pullErr = await new Response(pullProc.stderr).text();
  const pullCode = await pullProc.exited;

  if (pullCode !== 0) {
    log(`Update failed: ${pullErr.trim() || pullOut.trim()}`);
    // Rebuild frontend to restore deleted dist
    log("Rebuilding frontend to restore dist...");
    const recoveryBuild = Bun.spawn(["bun", "run", "build"], {
      cwd: frontendDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await recoveryBuild.exited;
    await startServer();
    throw new Error(`git pull failed: ${pullErr.trim() || pullOut.trim()}`);
  }

  for (const line of pullOut.trim().split("\n")) {
    if (line.trim()) log(`  ${line.trim()}`);
  }

  // Install dependencies and rebuild
  await installAndBuild(frontendDir);

  log("Update complete. Restarting server...");
  await startServer();
}

/**
 * Switch branch: stash → stop → clear cache → delete dist → checkout → pull → install → build → restart
 */
export async function switchBranch(
  target: string,
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>
): Promise<void> {
  if (!AVAILABLE_BRANCHES.includes(target as any)) {
    throw new Error(`Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
  }

  const currentBranch = getCurrentBranch();
  log(`Switching from '${currentBranch}' to '${target}'...`);

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", `lumiverse-branch-switch-${currentBranch}`);
  }

  // Stop server
  await stopServer();

  // Clear transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist
  const frontendDistDir = join(PROJECT_ROOT, "frontend", "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Checkout
  const checkout = runGit("checkout", target);
  if (!checkout.ok) {
    log(`Failed to checkout '${target}': ${checkout.out}`);
    // Rebuild frontend to restore deleted dist
    log("Rebuilding frontend to restore dist...");
    const recoveryBuild = Bun.spawn(["bun", "run", "build"], {
      cwd: join(PROJECT_ROOT, "frontend"),
      stdout: "ignore",
      stderr: "ignore",
    });
    await recoveryBuild.exited;
    await startServer();
    throw new Error(`git checkout failed: ${checkout.out}`);
  }

  log(`Checked out '${target}'.`);

  // Pull latest
  log("Pulling latest changes...");
  const pullProc = Bun.spawn(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pullOut = await new Response(pullProc.stdout).text();
  const pullErr = await new Response(pullProc.stderr).text();
  const pullCode = await pullProc.exited;

  if (pullCode !== 0) {
    log(`Pull failed (non-fatal): ${pullErr.trim() || pullOut.trim()}`);
  } else {
    for (const line of pullOut.trim().split("\n").filter((l: string) => l.trim())) {
      log(`  ${line.trim()}`);
    }
  }

  // Install and rebuild
  const frontendDir = join(PROJECT_ROOT, "frontend");
  await installAndBuild(frontendDir);

  log(`Branch switch complete. Now on '${target}'. Restarting server...`);
  await startServer();
}

async function installAndBuild(frontendDir: string): Promise<void> {
  log("Installing backend dependencies...");
  const backendInstall = Bun.spawn(["bun", "install"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  await backendInstall.exited;
  log("Backend dependencies updated.");

  log("Installing frontend dependencies...");
  const feInstall = Bun.spawn(["bun", "install"], {
    cwd: frontendDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await feInstall.exited;
  log("Frontend dependencies updated.");

  log("Rebuilding frontend...");
  const buildProc = Bun.spawn(["bun", "run", "build"], {
    cwd: frontendDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const buildOut = await new Response(buildProc.stdout).text();
  const buildErr = await new Response(buildProc.stderr).text();
  const buildCode = await buildProc.exited;

  if (buildCode !== 0) {
    log(`Frontend build failed: ${buildErr.trim() || buildOut.trim()}`);
  } else {
    log("Frontend rebuilt successfully.");
  }
}
