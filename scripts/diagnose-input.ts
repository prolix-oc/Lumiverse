#!/usr/bin/env bun
/**
 * Interactive diagnostic for scripts/input.ts.
 *
 * Run it in the same terminal the affected user is using:
 *   bun scripts/diagnose-input.ts
 *
 * It prompts for a username and a password, then dumps:
 *   - JSON-stringified value (shows hidden CR/LF)
 *   - Length in JS code units
 *   - Array.from() length in code points
 *   - Every code point as hex
 *
 * If you see `\r` or `\n` in the JSON output, or extra trailing code points,
 * that's what's breaking seeding (owner.credentials ends up with a trailing
 * CR in the username and the password hash is computed against the wrong
 * bytes).  Paste the output and I'll adjust the fix.
 */

import { askText, askSecret, closeInput } from "./input";

function dump(label: string, value: string): void {
  const codes = Array.from(value).map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, "0"));
  console.log(`  ${label}`);
  console.log(`    JSON:      ${JSON.stringify(value)}`);
  console.log(`    length:    ${value.length}`);
  console.log(`    codePts:   ${Array.from(value).length}`);
  console.log(`    hex:       ${codes.join(" ")}`);
}

try {
  const username = await askText("Username", {
    defaultValue: "admin",
    validate: (v) => (v.length < 3 ? "must be at least 3 chars" : null),
  });
  const password = await askSecret("Password");
  const confirm = await askSecret("Confirm");

  console.log("");
  console.log("─── Captured ────────────────────────────────────");
  dump("username", username);
  dump("password", password);
  dump("confirm ", confirm);
  console.log(`  match:     ${password === confirm}`);
  console.log("─────────────────────────────────────────────────");
} finally {
  closeInput();
}
