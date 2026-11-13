#!/usr/bin/env bun
/**
 * Lumiverse Desktop prerequisite check.
 *
 * Run with: bun run desktop:doctor
 *
 * Reports whether this machine can build the desktop app, and prints the exact
 * remedy for anything missing. Exits non-zero when a required prerequisite is
 * absent so it can gate a build in a script.
 */

import {
  desktopBuildCommand,
  inspectDesktopToolchain,
  type ToolchainCheck,
} from "./desktop-toolchain";
import { printBanner, printDivider, theme } from "./ui";

const SYMBOL: Record<ToolchainCheck["status"], string> = {
  ok: `${theme.success}✓${theme.reset}`,
  missing: `${theme.warning}✗${theme.reset}`,
  unverified: `${theme.muted}?${theme.reset}`,
};

const PLATFORM_LABEL = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  other: "this platform",
} as const;

async function main() {
  printBanner("Desktop build prerequisites");

  const report = await inspectDesktopToolchain();
  console.log(`  ${theme.muted}Platform: ${PLATFORM_LABEL[report.platform]}${theme.reset}`);
  console.log("");

  const width = Math.max(...report.checks.map((check) => check.label.length));
  for (const check of report.checks) {
    console.log(`  ${SYMBOL[check.status]}  ${check.label.padEnd(width)}  ${theme.muted}${check.detail}${theme.reset}`);
  }

  const actionable = report.checks.filter((check) => check.status !== "ok" && check.remedy.length > 0);
  if (actionable.length > 0) {
    console.log("");
    printDivider();
    for (const check of actionable) {
      console.log("");
      console.log(`  ${theme.warning}${check.label}${theme.reset}`);
      for (const line of check.remedy) {
        console.log(`    ${theme.muted}${line}${theme.reset}`);
      }
    }
  }

  console.log("");
  printDivider();
  console.log("");
  if (report.ready) {
    console.log(`  ${theme.success}Ready to build.${theme.reset}`);
    console.log(`  ${theme.muted}From the repository root:${theme.reset}`);
    console.log(`    ${desktopBuildCommand()}`);
    if (report.platform === "other") {
      console.log("");
      console.log(`  ${theme.muted}Lumiverse Desktop targets macOS, Windows and Linux; this platform is untested.${theme.reset}`);
    }
  } else {
    console.log(`  ${theme.warning}Not ready to build.${theme.reset}`);
    console.log(`  ${theme.muted}Resolve the items above, then run this check again.${theme.reset}`);
  }
  console.log("");

  process.exit(report.ready ? 0 : 1);
}

main();
