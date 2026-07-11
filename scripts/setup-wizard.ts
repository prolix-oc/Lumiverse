#!/usr/bin/env bun
/**
 * Lumiverse First-Run Setup Wizard
 *
 * Interactive setup that generates .env and the identity file.
 * Run with: bun run scripts/setup-wizard.ts
 *
 * Can also be run non-interactively via environment variables:
 *   OWNER_USERNAME, OWNER_PASSWORD, PORT, SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { hashPassword } from "../src/crypto/password";
import { createIdentityFile, bytesToHex } from "../src/crypto/identity";
import { writeOwnerCredentials } from "../src/crypto/credentials";
import {
  getSmartctlStatus,
  resetSmartctlResolution,
} from "../src/services/smartctl.service";
import {
  printBanner,
  printStepHeader,
  printSummary,
  printDivider,
  printCompletionAnimation,
  theme,
} from "./ui";
import { askSecret, askText, closeInput } from "./input";

// All input goes through askText / askSecret (scripts/input.ts) so that a
// single raw-mode consumer owns stdin.  Mixing Node's readline with a raw
// password prompt produces double-echoed characters on Windows ConPTY and
// Termux and occasionally drops bytes between listeners.

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

function parseStorageInput(input: string): number | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = (match[2] || "mb").toLowerCase();
  switch (unit) {
    case "gb": return Math.floor(value * 1024 * 1024 * 1024);
    case "mb": return Math.floor(value * 1024 * 1024);
    case "kb": return Math.floor(value * 1024);
    case "b":  return Math.floor(value);
    default:   return null;
  }
}

function processIsElevated(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function runSmartctlInstaller(command: string[]): Promise<number> {
  const proc = Bun.spawn({
    cmd: command,
    // The package manager may show its native sudo prompt. No password goes
    // through Lumiverse; it is handled entirely by the operating system.
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const projectRoot = resolve(import.meta.dir, "..");
  const dataDir = join(projectRoot, "data");
  const envPath = join(projectRoot, ".env");
  const identityPath = join(dataDir, "lumiverse.identity");
  const credentialsPath = join(dataDir, "owner.credentials");

  // Guard: don't overwrite existing setup
  if (existsSync(identityPath) && existsSync(credentialsPath) && existsSync(envPath)) {
    console.log("");
    console.log(`  ${theme.warning}Setup already complete.${theme.reset}`);
    console.log(`  ${theme.muted}To reconfigure, delete .env, data/lumiverse.identity, and data/owner.credentials.${theme.reset}`);
    console.log("");
    process.exit(0);
  }

  // ─── Banner ────────────────────────────────────────────────────────────

  printBanner("First-Time Setup Wizard");
  printDivider();

  // ─── Step 1: Admin account ─────────────────────────────────────────────

  printStepHeader(1, 5, "Admin Account", "Create the owner account for your Lumiverse instance.");

  // BetterAuth rejects very short usernames and our macro/URL paths assume a
  // non-trivial identifier.  Validate up-front so a fat-finger doesn't seed
  // an unrecoverable owner account.
  const username = await askText("Username", {
    defaultValue: "admin",
    validate: (v) => {
      if (v.length < 3) return "Username must be at least 3 characters.";
      if (v.length > 32) return "Username must be at most 32 characters.";
      if (!/^[a-zA-Z0-9_.]+$/.test(v)) {
        return "Username may only contain letters, numbers, underscores, and dots.";
      }
      return null;
    },
  });

  let password = "";
  while (!password) {
    password = await askSecret("Password");
    if (!password) {
      console.log(`    ${theme.warning}Password cannot be empty.${theme.reset}`);
    } else if (password.length < 8) {
      console.log(`    ${theme.warning}Password must be at least 8 characters.${theme.reset}`);
      password = "";
    }
  }

  let confirmPassword = "";
  while (confirmPassword !== password) {
    confirmPassword = await askSecret("Confirm password");
    if (confirmPassword !== password) {
      console.log(`    ${theme.warning}Passwords do not match. Try again.${theme.reset}`);
    }
  }

  console.log("");
  printDivider();

  // ─── Step 2: Server port ───────────────────────────────────────────────

  printStepHeader(2, 5, "Server Port", "The port Lumiverse will listen on.");

  let port = 7860;
  const portInput = await askText("Port", { defaultValue: "7860" });
  const parsedPort = parseInt(portInput, 10);
  if (parsedPort > 0 && parsedPort <= 65535) {
    port = parsedPort;
  } else if (portInput !== "" && portInput !== "7860") {
    console.log(`    ${theme.warning}Invalid port. Using default 7860.${theme.reset}`);
  }

  console.log("");
  printDivider();

  // ─── Step 3: Extension storage ─────────────────────────────────────────

  printStepHeader(3, 5, "Extension Storage", "Maximum disk budget for Spindle extension data pools.");

  const defaultStorage = 500 * 1024 * 1024; // 500MB
  const storageInput = await askText("Max extension storage", { defaultValue: "500MB" });
  let globalMax = defaultStorage;
  const parsed = parseStorageInput(storageInput);
  if (parsed && parsed > 0) {
    globalMax = parsed;
  } else if (storageInput !== "" && storageInput.toLowerCase() !== "500mb") {
    console.log(`    ${theme.warning}Could not parse input. Using default 500MB.${theme.reset}`);
  }

  const perExtDefault = Math.min(Math.floor(globalMax / 10), 50 * 1024 * 1024);
  console.log(`    ${theme.muted}Per-extension default: ${formatBytes(perExtDefault)}${theme.reset}`);

  console.log("");
  printDivider();

  // ─── Step 4: Optional SMART support ────────────────────────────────────

  printStepHeader(4, 5, "Disk Health Monitoring", "Install smartmontools so Lumiverse can report physical-drive SMART health.");

  let smartStatus = await getSmartctlStatus();
  if (smartStatus.binary) {
    console.log(`    ${theme.success}smartctl detected${theme.reset}${smartStatus.binary.version ? ` ${theme.muted}(v${smartStatus.binary.version})${theme.reset}` : ""}`);
  } else if (!smartStatus.installPlan) {
    console.log(`    ${theme.muted}${smartStatus.message}${theme.reset}`);
  } else {
    // Default to yes: this is a fixed command from a small allowlist and is
    // the least-friction way to enable the optional diagnostics feature.
    const installAnswer = await askText("Install smartmontools now? [Y/n]", { defaultValue: "y" });
    const wantsInstall = !/^n(?:o)?$/i.test(installAnswer);
    if (wantsInstall) {
      const plan = smartStatus.installPlan;
      let command = [...plan.command];
      if (plan.requiresElevation) {
        if (platform() === "win32") {
          console.log(`    ${theme.warning}Open PowerShell as Administrator, then run:${theme.reset}`);
          console.log(`    ${theme.muted}${command.join(" ")}${theme.reset}`);
          console.log(`    ${theme.muted}After it finishes, restart Lumiverse.${theme.reset}`);
          command = [];
        } else if (!processIsElevated()) {
          command = ["sudo", "--", ...command];
        }
      }

      if (command.length > 0) {
        // readline owns stdin for the wizard. Release it before handing the
        // terminal to sudo/homebrew so its native interaction remains intact.
        closeInput();
        console.log(`    ${theme.muted}Running ${plan.manager} installer…${theme.reset}`);
        const exitCode = await runSmartctlInstaller(command);
        resetSmartctlResolution();
        smartStatus = await getSmartctlStatus();
        if (exitCode === 0 && smartStatus.binary) {
          console.log(`    ${theme.success}smartctl installed successfully.${theme.reset}`);
        } else {
          console.log(`    ${theme.warning}Installation did not complete. SMART monitoring will stay optional.${theme.reset}`);
        }
      }
    } else {
      console.log(`    ${theme.muted}Skipped. Install later with: bun run install:smartctl${theme.reset}`);
    }
  }

  console.log("");
  printDivider();

  // ─── Step 5: Generate identity + write config ─────────────────────────

  printStepHeader(5, 5, "Generating Identity", "Creating your encryption identity and credentials.");

  await printCompletionAnimation();

  // Generate identity file
  if (!existsSync(identityPath)) {
    await createIdentityFile(identityPath);
  }

  // Hash password and write credentials file
  const passwordHash = await hashPassword(password);
  await writeOwnerCredentials(credentialsPath, username, passwordHash);

  // Build .env content (no plaintext credentials!)
  const envLines = [
    "# Lumiverse Configuration",
    `# Generated by setup wizard on ${new Date().toISOString()}`,
    "",
    "# Server",
    `PORT=${port}`,
    "",
    "# Admin username (password is stored hashed in data/owner.credentials)",
    `OWNER_USERNAME=${username}`,
    "",
    "# Extension storage",
    `SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES=${globalMax}`,
    `SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES=${perExtDefault}`,
    "SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES=",
    "SPINDLE_EPHEMERAL_RESERVATION_TTL_MS=600000",
    "",
    "# Optional: path to built frontend dist",
    "# FRONTEND_DIR=",
    "",
    "# Optional: trusted origins for CORS (comma-separated)",
    "# Leave unset to allow all origins",
    "# TRUSTED_ORIGINS=http://localhost:5173,http://localhost:7860",
    "",
  ];

  // Merge with existing .env if it exists (preserve user edits)
  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, "utf-8");
    const existingKeys = new Set(
      existing.split("\n")
        .filter(l => l.match(/^[A-Z_]+=./))
        .map(l => l.split("=")[0])
    );

    const newLines: string[] = [];
    for (const line of envLines) {
      const keyMatch = line.match(/^([A-Z_]+)=/);
      if (keyMatch && existingKeys.has(keyMatch[1])) {
        continue;
      }
      newLines.push(line);
    }

    if (newLines.some(l => l.match(/^[A-Z_]+=./))) {
      const merged = existing.trimEnd() + "\n\n# Added by setup wizard\n" + newLines.join("\n") + "\n";
      writeFileSync(envPath, merged);
    }
  } else {
    writeFileSync(envPath, envLines.join("\n"));
  }

  // ─── Summary ──────────────────────────────────────────────────────────

  printSummary(
    "Setup Complete",
    [
      { label: "Admin user",        value: username },
      { label: "Port",              value: String(port) },
      { label: "Extension storage", value: formatBytes(globalMax) },
      { label: "Identity file",     value: "data/lumiverse.identity" },
      { label: "Credentials",       value: "data/owner.credentials" },
      { label: "Config",            value: ".env" },
    ],
    [
      "Keep the data/ directory safe — it contains your encryption key,",
      "credentials, and database. Back up the entire data/ folder.",
      "To reset your password: bun run reset-password",
    ]
  );
}

main()
  .catch((err) => {
    console.error("Setup failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeInput());
