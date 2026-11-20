#!/usr/bin/env bun
/**
 * Lumiverse .env Editor
 *
 * Opens the `.env` in a terminal editor, picking a sensible one for the
 * platform so users don't have to know the path or wrangle an editor:
 *
 *   - Termux (Android): opens nano (the de-facto Termux editor). If nano is
 *     missing, suggests `pkg install nano` and falls back to $EDITOR/vi.
 *   - Linux / macOS: detects installed editors (honoring $VISUAL/$EDITOR, then
 *     nano, vim, vi, emacs) and lets you choose.
 *   - Windows: honors an explicitly-set $VISUAL/$EDITOR, otherwise Notepad.
 *     (Windows has no reliable "default editor" for unassociated files like
 *     .env — `start`/Invoke-Item would just pop the "Open with…" picker.)
 *
 * If `.env` doesn't exist it offers to create one from `.env.example`.
 *
 * Run with:
 *   bun run edit-env                 # via package.json alias
 *   bun run scripts/edit-env.ts
 *   bun run scripts/edit-env.ts --path        # just print the .env path and exit
 *   bun run scripts/edit-env.ts /custom/.env  # edit a specific file
 *
 * Note: edits `./.env` in your current working directory (which is the project
 * root when launched via `bun run`). Pass a path to override.
 */

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { theme, printBox, printDivider } from "./ui";
import { askText, closeInput } from "./input";

const scriptRoot = resolve(import.meta.dir, "..");
const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
const envPath = positional ? resolve(positional) : join(process.cwd(), ".env");
// Prefer an .env.example sitting next to the target; fall back to the repo's.
const envDir = dirname(envPath);
const examplePath = existsSync(join(envDir, ".env.example"))
  ? join(envDir, ".env.example")
  : join(scriptRoot, ".env.example");

// ─── Helpers ──────────────────────────────────────────────────────────────

interface Editor {
  /** Absolute path to the binary (robust to spawn across platforms). */
  bin: string;
  args: string[];
  /** Short name for display. */
  name: string;
}

const isTermux = (): boolean =>
  process.platform === "linux" &&
  (!!process.env.TERMUX_VERSION || (process.env.PREFIX ?? "").includes("com.termux"));

/** Resolve an editor spec ("nano", "code --wait", …) to a runnable Editor. */
function resolveSpec(spec: string | undefined | null): Editor | null {
  if (!spec) return null;
  const parts = spec.trim().split(/\s+/);
  const name = parts[0];
  if (!name) return null;
  const found = Bun.which(name) ?? (existsSync(name) ? name : null);
  return found ? { bin: found, args: parts.slice(1), name } : null;
}

interface EditorChoice {
  editor: Editor;
  label: string;
}

/** Ordered, de-duplicated list of usable editors on Linux/macOS. */
function detectEditors(): EditorChoice[] {
  const out: EditorChoice[] = [];
  const seen = new Set<string>();
  const add = (spec: string | undefined, note?: string) => {
    const editor = resolveSpec(spec);
    if (!editor || seen.has(editor.name)) return;
    seen.add(editor.name);
    out.push({ editor, label: note ? `${spec}  ${theme.muted}${note}${theme.reset}` : spec! });
  };
  add(process.env.VISUAL, "$VISUAL");
  add(process.env.EDITOR, "$EDITOR");
  for (const e of ["nano", "vim", "vi", "emacs"]) add(e);
  return out;
}

async function askYesNo(question: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const ans = await askText(`${question} ${def ? "[Y/n]" : "[y/N]"}`, { defaultValue: def ? "y" : "n" });
  return /^y(es)?$/i.test(ans.trim());
}

/** Hand the TTY fully to the editor and wait for it to exit. */
function launch(editor: Editor): number {
  console.log(`\n  ${theme.muted}Opening ${envPath} in ${theme.reset}${theme.secondary}${editor.name}${theme.reset}${theme.muted}…${theme.reset}\n`);
  // Release stdin (the readline interface owns it) before the editor takes over.
  closeInput();
  const res = spawnSync(editor.bin, [...editor.args, envPath], { stdio: "inherit" });
  if (res.error) {
    console.error(`  ${theme.error}Failed to launch ${editor.name}: ${res.error.message}${theme.reset}`);
    return 1;
  }
  return res.status ?? 0;
}

function noEditorFound(hint: string): never {
  console.log("");
  printBox(
    [
      `${theme.warning}No terminal editor found.${theme.reset}`,
      "",
      hint,
      "",
      `${theme.muted}Or edit it directly:${theme.reset}  ${envPath}`,
    ],
    theme.warning,
  );
  console.log("");
  closeInput();
  process.exit(1);
}

// ─── Ensure the file exists ─────────────────────────────────────────────────

async function ensureEnvFile(): Promise<void> {
  if (existsSync(envPath)) return;
  const fromExample = existsSync(examplePath);
  console.log(`  ${theme.warning}No .env found at${theme.reset} ${envPath}`);
  const create = await askYesNo(`  Create it${fromExample ? " from .env.example" : " (empty)"}?`, true);
  if (!create) {
    console.log(`  ${theme.muted}Aborted — nothing created.${theme.reset}`);
    closeInput();
    process.exit(0);
  }
  if (fromExample) copyFileSync(examplePath, envPath);
  else writeFileSync(envPath, "");
  console.log(`  ${theme.success}Created${theme.reset} ${envPath}${fromExample ? `  ${theme.muted}(from .env.example)${theme.reset}` : ""}`);
}

// ─── Editor selection per platform ──────────────────────────────────────────

async function resolveEditor(): Promise<Editor> {
  // Windows → explicit $VISUAL/$EDITOR if set, else Notepad (always works).
  if (process.platform === "win32") {
    return resolveSpec(process.env.VISUAL) ?? resolveSpec(process.env.EDITOR) ?? { bin: "notepad.exe", args: [], name: "Notepad" };
  }

  // Termux → prefer nano, then fall back.
  if (isTermux()) {
    const nano = resolveSpec("nano");
    if (nano) return nano;
    const fallback = resolveSpec(process.env.EDITOR) ?? resolveSpec("vi") ?? resolveSpec("vim");
    if (fallback) {
      console.log(`  ${theme.warning}nano not installed — run \`pkg install nano\` for the smoothest experience.${theme.reset}`);
      console.log(`  ${theme.muted}Falling back to ${fallback.name}.${theme.reset}`);
      return fallback;
    }
    noEditorFound(`${theme.bold}Install nano:${theme.reset}  pkg install nano`);
  }

  // Linux / macOS → present detected editors.
  const editors = detectEditors();
  if (editors.length === 0) {
    noEditorFound(`${theme.bold}Install one:${theme.reset}  e.g. nano, vim, or set $EDITOR`);
  }
  if (editors.length === 1 || !process.stdin.isTTY) {
    return editors[0].editor;
  }

  console.log(`  ${theme.bold}Choose an editor:${theme.reset}\n`);
  editors.forEach((e, i) => console.log(`    ${theme.secondary}${i + 1}${theme.reset}) ${e.label}`));
  console.log("");
  const choice = await askText("Open .env with", {
    defaultValue: "1",
    validate: (v) => {
      const n = parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= editors.length
        ? null
        : `Enter a number between 1 and ${editors.length}.`;
    },
  });
  return editors[parseInt(choice, 10) - 1].editor;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("\n  Edit the Lumiverse .env file in your platform's editor.\n");
    console.log("  Usage:  bun run edit-env [--path] [file]\n");
    console.log("    --path    print the resolved .env path and exit");
    console.log("    file      edit a specific file instead of ./.env\n");
    return;
  }

  if (process.argv.includes("--path")) {
    console.log(envPath);
    return;
  }

  console.log("");
  printDivider();
  console.log(`  ${theme.primary}${theme.bold}Lumiverse · Edit .env${theme.reset}`);
  console.log(`  ${theme.muted}${envPath}${theme.reset}\n`);

  await ensureEnvFile();
  const editor = await resolveEditor();
  const status = launch(editor);

  console.log("");
  printBox(
    [
      status === 0
        ? `${theme.success}Done editing .env${theme.reset}`
        : `${theme.warning}Editor exited with code ${status}${theme.reset}`,
      "",
      `${theme.muted}Restart Lumiverse for changes to take effect${theme.reset}`,
      `${theme.muted}(re-run \`bun run start\`, or restart the service/container).${theme.reset}`,
    ],
    theme.secondary,
  );
  console.log("");
}

main()
  .catch((err) => {
    console.error(`\n${theme.error}edit-env failed:${theme.reset}`, err);
    closeInput();
    process.exit(1);
  })
  .then(() => closeInput());
