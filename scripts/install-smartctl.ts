#!/usr/bin/env bun
/**
 * Install smartmontools through the host's existing package manager.
 *
 * This is deliberately separate from the first-run wizard: Linux package
 * managers often need sudo, and running the entire wizard as root would make
 * Lumiverse's data files root-owned. The only possible prompt is the normal
 * OS elevation prompt; no password is handled by this script.
 */
import { platform } from "node:os";
import {
  getSmartctlInstallPlan,
  getSmartctlStatus,
  resetSmartctlResolution,
} from "../src/services/smartctl.service";

function isElevated(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function runInteractive(cmd: string[]): Promise<number> {
  const proc = Bun.spawn({
    cmd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  const before = await getSmartctlStatus();
  if (before.binary) {
    console.log(`smartctl is already installed (${before.binary.path}${before.binary.version ? `, v${before.binary.version}` : ""}).`);
    return;
  }

  const plan = await getSmartctlInstallPlan();
  if (!plan) {
    console.error(before.message);
    process.exitCode = 1;
    return;
  }

  let command = [...plan.command];
  if (plan.requiresElevation) {
    if (platform() === "win32") {
      console.error("Open PowerShell as Administrator and run:");
      console.error(`  ${command.join(" ")}`);
      process.exitCode = 1;
      return;
    }
    if (!isElevated()) command = ["sudo", "--", ...command];
  }

  console.log(`Installing smartmontools with ${plan.manager}...`);
  const exitCode = await runInteractive(command);
  if (exitCode !== 0) {
    console.error(`smartmontools installation failed (exit ${exitCode}).`);
    process.exitCode = exitCode || 1;
    return;
  }

  resetSmartctlResolution();
  const after = await getSmartctlStatus();
  if (!after.binary) {
    console.error("The package command completed, but smartctl was not found on PATH. Set LUMIVERSE_SMARTCTL_PATH to its full path.");
    process.exitCode = 1;
    return;
  }
  console.log(`smartctl installed successfully (${after.binary.path}${after.binary.version ? `, v${after.binary.version}` : ""}).`);
}

main().catch((err) => {
  console.error("Unable to install smartmontools:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
