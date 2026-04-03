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
import { join, resolve } from "node:path";
import { createInterface } from "readline";
import { hashPassword } from "../src/crypto/password";
import { createIdentityFile, bytesToHex } from "../src/crypto/identity";
import { writeOwnerCredentials } from "../src/crypto/credentials";
import {
  printBanner,
  printStepHeader,
  printSummary,
  printDivider,
  printCompletionAnimation,
  promptLabel,
  inputHint,
  theme,
} from "./ui";
import { askSecret } from "./input";

// ─── Input helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` ${inputHint(`(${defaultValue})`)}` : "";
  return new Promise((resolve) => {
    rl.question(`${promptLabel(question)}${hint} `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

// askSecret imported from ./input — byte-level processing, NFC normalization

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

  printStepHeader(1, 4, "Admin Account", "Create the owner account for your Lumiverse instance.");

  const username = await ask("Username", "admin");

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

  printStepHeader(2, 4, "Server Port", "The port Lumiverse will listen on.");

  let port = 7860;
  const portInput = await ask("Port", "7860");
  const parsedPort = parseInt(portInput, 10);
  if (parsedPort > 0 && parsedPort <= 65535) {
    port = parsedPort;
  } else if (portInput !== "" && portInput !== "7860") {
    console.log(`    ${theme.warning}Invalid port. Using default 7860.${theme.reset}`);
  }

  console.log("");
  printDivider();

  // ─── Step 3: Extension storage ─────────────────────────────────────────

  printStepHeader(3, 4, "Extension Storage", "Maximum disk budget for Spindle extension data pools.");

  const defaultStorage = 500 * 1024 * 1024; // 500MB
  const storageInput = await ask("Max extension storage", "500MB");
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

  // ─── Step 4: Generate identity + write config ─────────────────────────

  printStepHeader(4, 4, "Generating Identity", "Creating your encryption identity and credentials.");

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

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
