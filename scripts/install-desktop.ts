#!/usr/bin/env bun
/** Build Lumiverse Desktop and install it for the current user. */

import { join } from "node:path";
import { inspectDesktopToolchain } from "./desktop-toolchain";
import {
  currentInstallPlatform,
  installDesktopBundle,
  selectDesktopInstallArtifact,
} from "./desktop-installer";
import { recoverStaleGitIndexLock, resolveGitIndexLock } from "./git-index-lock";
import { rebuildDesktopShell } from "./runner/git-ops";
import { PROJECT_ROOT } from "./runner/lib/constants";
import { installRustForWindows } from "./windows-rust-installer";

function lockFailureMessage(status: "active" | "recent" | "changed", lockPath: string): string {
  if (status === "active") {
    return `Git is still running and owns ${lockPath}. Let it finish (or close the process) before rebuilding.`;
  }
  if (status === "recent") {
    return `Git recently created ${lockPath}. Wait 30 seconds and retry so an active operation is not interrupted.`;
  }
  return `Git changed ${lockPath} while it was being checked. Wait for the active operation to finish and retry.`;
}

async function main(): Promise<void> {
  console.log("\nLumiverse Desktop — Build and install\n");

  if (process.env.LUMIVERSE_IS_TERMUX === "true" || process.env.LUMIVERSE_IS_PROOT === "true") {
    throw new Error("the Tauri desktop client cannot be installed on Android/Termux");
  }

  const initialLock = await recoverStaleGitIndexLock(PROJECT_ROOT);
  if (initialLock.status === "recovered") {
    console.warn(`Recovered stale Git lock left by an interrupted operation: ${initialLock.lockPath}\n`);
  } else if (
    (initialLock.status === "active" || initialLock.status === "recent" || initialLock.status === "changed")
    && initialLock.lockPath
  ) {
    throw new Error(lockFailureMessage(initialLock.status, initialLock.lockPath));
  }

  const target = currentInstallPlatform();
  let report = await inspectDesktopToolchain();
  const cargoMissing = report.checks.some(
    (check) => check.id === "cargo" && check.status === "missing",
  );
  if (target === "win32" && cargoMissing) {
    console.log("Rust is required for Tauri but is not installed.");
    console.log("Downloading the official Rustup installer and installing stable Rust...\n");
    try {
      const installed = await installRustForWindows();
      console.log(`Rust installed. Added ${installed.cargoBin} to PATH for this build.\n`);
    } catch (error) {
      throw new Error(
        `automatic Rust installation failed: ${error instanceof Error ? error.message : String(error)}. `
        + "Run 'bun run desktop:doctor' for manual installation instructions.",
      );
    }
    report = await inspectDesktopToolchain();
  }

  if (!report.ready) {
    console.error("Missing desktop build prerequisites:\n");
    for (const check of report.checks.filter((candidate) => candidate.status === "missing")) {
      console.error(`  ${check.label}: ${check.detail}`);
      for (const line of check.remedy) console.error(`    ${line}`);
    }
    console.error("\nRun 'bun run desktop:doctor' after installing the missing prerequisites.\n");
    process.exitCode = 1;
    return;
  }

  console.log("Building the Tauri desktop app (the first build can take several minutes)...\n");
  const indexLockPath = resolveGitIndexLock(PROJECT_ROOT);
  const lockExistedBeforeBuild = indexLockPath ? await Bun.file(indexLockPath).exists() : false;
  try {
    await rebuildDesktopShell(undefined, { mirrorOutput: true });
  } finally {
    // Attribute cleanup only to a lock that appeared during this build. The
    // process scan still protects a concurrent external Git command.
    if (!lockExistedBeforeBuild && indexLockPath && await Bun.file(indexLockPath).exists()) {
      const cleanup = await recoverStaleGitIndexLock(PROJECT_ROOT, { minimumAgeMs: 0 });
      if (cleanup.status === "recovered") {
        console.warn(`Removed Git lock left by the completed desktop build: ${cleanup.lockPath}`);
      } else if (cleanup.status !== "absent") {
        console.warn(`Preserved ${indexLockPath} because Git may still be using it (${cleanup.status}).`);
      }
    }
  }

  const bundleRoot = join(PROJECT_ROOT, "desktop", "src-tauri", "target", "release", "bundle");
  const artifact = selectDesktopInstallArtifact(bundleRoot, target);
  if (!artifact) {
    throw new Error(`The Tauri build did not produce an installable ${target} artifact in ${bundleRoot}`);
  }

  console.log(`\nInstalling ${artifact}...`);
  const result = await installDesktopBundle(artifact, target);
  console.log(`\nLumiverse Desktop installed: ${result.installedPath}`);
  for (const shortcut of result.shortcuts) console.log(`  Shortcut: ${shortcut}`);
  console.log("\nYou can rerun this command to replace an older scripted install.\n");
}

main().catch((error) => {
  console.error(`\nDesktop installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
