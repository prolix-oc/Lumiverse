#!/usr/bin/env bun
/**
 * Lumiverse Owner Password Reset
 *
 * Resets the owner account password without needing the old password.
 * Must be run on the host machine with access to the data/ directory.
 *
 * Run with: bun run reset-password
 *
 * What it does:
 *   1. Validates that data/lumiverse.identity exists (confirms this is a Lumiverse instance)
 *   2. Opens the database and finds the owner account
 *   3. Prompts for a new password (with confirmation)
 *   4. Updates the password hash in both the database and data/owner.credentials
 *   5. Revokes all active sessions (forces re-login)
 */

import { join, resolve } from "node:path";
import Database from "bun:sqlite";
import { hashPassword } from "../src/crypto/password";
import { readIdentityFile } from "../src/crypto/identity";
import { writeOwnerCredentials } from "../src/crypto/credentials";
import {
  printBanner,
  printStepHeader,
  printSummary,
  printDivider,
  theme,
} from "./ui";
import { askSecret, closeInput } from "./input";

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const projectRoot = resolve(import.meta.dir, "..");
  const dataDir = join(projectRoot, "data");
  const identityPath = join(dataDir, "lumiverse.identity");
  const credentialsPath = join(dataDir, "owner.credentials");
  const dbPath = join(dataDir, "lumiverse.db");

  // ─── Banner ────────────────────────────────────────────────────────────

  printBanner("Password Reset");
  printDivider();

  // ─── Step 1: Validate instance ─────────────────────────────────────────

  printStepHeader(1, 3, "Validate Instance", "Checking for Lumiverse identity and database.");

  if (!(await Bun.file(identityPath).exists())) {
    console.log(`  ${theme.error}Identity file not found: ${identityPath}${theme.reset}`);
    console.log(`  ${theme.muted}This doesn't appear to be a configured Lumiverse instance.${theme.reset}`);
    console.log(`  ${theme.muted}Run the setup wizard first: bun run setup${theme.reset}`);
    console.log("");
    process.exit(1);
  }

  // Validate the identity file is readable and not corrupted
  try {
    await readIdentityFile(identityPath);
    console.log(`  ${theme.success}Identity file valid${theme.reset}`);
  } catch (err: any) {
    console.log(`  ${theme.error}Identity file is corrupted: ${err.message}${theme.reset}`);
    process.exit(1);
  }

  if (!(await Bun.file(dbPath).exists())) {
    console.log(`  ${theme.error}Database not found: ${dbPath}${theme.reset}`);
    console.log(`  ${theme.muted}The server must be started at least once before resetting the password.${theme.reset}`);
    console.log("");
    process.exit(1);
  }

  // Open database read-write
  const db = new Database(dbPath);

  // Find the owner account
  type UserRow = { id: string; username: string; role: string };
  let owner: UserRow | null = db
    .query('SELECT id, username, role FROM "user" WHERE role = ? LIMIT 1')
    .get("owner") as UserRow | null;

  if (!owner) {
    // Fall back to the first-created user
    owner = db
      .query('SELECT id, username, role FROM "user" ORDER BY createdAt ASC LIMIT 1')
      .get() as UserRow | null;
  }

  if (!owner) {
    console.log(`  ${theme.error}No user accounts found in the database.${theme.reset}`);
    console.log(`  ${theme.muted}Run the setup wizard: bun run setup${theme.reset}`);
    console.log("");
    db.close();
    process.exit(1);
  }

  console.log(`  ${theme.success}Owner account found: ${theme.bold}${owner.username}${theme.reset}`);

  console.log("");
  printDivider();

  // ─── Step 2: New password ──────────────────────────────────────────────

  printStepHeader(2, 3, "New Password", `Set a new password for "${owner.username}".`);

  let password = "";
  while (!password) {
    password = await askSecret("New password");
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

  // ─── Step 3: Apply changes ─────────────────────────────────────────────

  printStepHeader(3, 3, "Applying Changes", "Updating password and revoking sessions.");

  // Hash the password
  const passwordHash = await hashPassword(password);

  // Update the account table
  const result = db.run(
    'UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = ?',
    [passwordHash, Math.floor(Date.now() / 1000), owner.id, "credential"]
  );

  if (result.changes === 0) {
    console.log(`  ${theme.error}Failed to update password — no credential account found for this user.${theme.reset}`);
    db.close();
    process.exit(1);
  }

  console.log(`  ${theme.success}Password updated in database${theme.reset}`);

  // Revoke all sessions
  const sessions = db.run("DELETE FROM session WHERE userId = ?", [owner.id]);
  console.log(`  ${theme.success}Revoked ${sessions.changes} active session(s)${theme.reset}`);

  // Update the credentials file
  await writeOwnerCredentials(credentialsPath, owner.username, passwordHash);
  console.log(`  ${theme.success}Credentials file updated${theme.reset}`);

  db.close();

  // ─── Summary ──────────────────────────────────────────────────────────

  printSummary(
    "Password Reset Complete",
    [
      { label: "Account",     value: owner.username },
      { label: "Sessions",    value: `${sessions.changes} revoked` },
      { label: "Credentials", value: "data/owner.credentials" },
    ],
    [
      "You will need to log in again with your new password.",
    ]
  );

}

main()
  .catch((err) => {
    console.error("Password reset failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeInput());
