#!/usr/bin/env bun
/**
 * SillyTavern → Lumiverse gallery dry-run audit.
 *
 * Read-only. Inventories every character card in a SillyTavern user data dir,
 * resolves each CharacterLibrary gallery folder, indexes gallery contents, and
 * matches the card's external media URLs against the local files that
 * CharacterLibrary localized into those folders.
 *
 * Nothing is uploaded, copied, or modified; no bundle is produced.
 *
 * Usage:
 *   bun run audit:st-gallery -- --data-dir /path/to/SillyTavern/data/default-user
 *   bun run audit:st-gallery -- --data-dir ... --out data/reports --include-chats
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { printBanner, printSummary, printDivider, theme } from "./ui";
import { runGalleryAudit, detectClSettings } from "../src/migration/st-gallery-audit";
import { formatSummary } from "../src/migration/st-gallery-audit/reports";

const HELP = `SillyTavern → Lumiverse gallery dry-run audit (read-only)

  bun run audit:st-gallery -- --data-dir <ST user data dir> [options]

Options
  --data-dir PATH       SillyTavern user data dir (the one containing
                        "characters/" and "user/images/"). Required.
  --out DIR             Report directory. Default: data/reports/st-gallery-audit-<stamp>
  --include-chats       Also scan chats/*/*.jsonl for external media URLs
  --include-lorebook    Scan character_book entries for media URLs
  --no-lorebook         Do not scan character_book entries (default)
  --unique-folders      Force CL uniqueGalleryFolders ON
  --no-unique-folders   Force CL uniqueGalleryFolders OFF
  --concurrency N       Card metadata read concurrency (default: worker budget, max 16)
  --help, -h            Show this help

The audit never writes to the SillyTavern directory and never modifies
Lumiverse. It reports unique / ambiguous / missing localizations per URL.`;

export interface Options {
  dataDir: string;
  outDir: string;
  includeChats: boolean;
  includeLorebook?: boolean;
  uniqueGalleryFolders?: boolean;
  concurrency?: number;
  help: boolean;
}

export function parseOptions(args: string[]): Options {
  const options: Options = {
    dataDir: "",
    outDir: "",
    includeChats: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--data-dir": options.dataDir = args[++i] ?? ""; break;
      case "--out": options.outDir = args[++i] ?? ""; break;
      case "--include-chats": options.includeChats = true; break;
      case "--include-lorebook": options.includeLorebook = true; break;
      case "--no-lorebook": options.includeLorebook = false; break;
      case "--unique-folders": options.uniqueGalleryFolders = true; break;
      case "--no-unique-folders": options.uniqueGalleryFolders = false; break;
      case "--concurrency": {
        const value = Number(args[++i]);
        if (!Number.isFinite(value) || value < 1) throw new Error("--concurrency must be a positive integer");
        options.concurrency = Math.min(Math.floor(value), 16);
        break;
      }
      case "--help": case "-h": options.help = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        break;
    }
  }
  return options;
}

/** `2026-01-31T04-22-19-123Z` — filesystem- and lexicographically-sortable. */
function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || !options.dataDir) {
    console.log(HELP);
    return options.help ? 0 : 2;
  }

  const dataDir = resolve(options.dataDir);
  if (!existsSync(dataDir)) {
    console.error(`${theme.error}Data directory not found: ${dataDir}${theme.reset}`);
    return 1;
  }
  if (!existsSync(join(dataDir, "characters"))) {
    console.error(`${theme.error}No "characters/" directory inside ${dataDir}. Point --data-dir at a SillyTavern user folder.${theme.reset}`);
    return 1;
  }

  const outDir = resolve(options.outDir || join("data", "reports", `st-gallery-audit-${timestampSlug()}`));

  printBanner("SillyTavern gallery dry-run audit");
  const detected = detectClSettings(dataDir);
  console.log(`  ${theme.muted}Source:${theme.reset} ${dataDir}`);
  console.log(`  ${theme.muted}Reports:${theme.reset} ${outDir}`);
  console.log(`  ${theme.muted}uniqueGalleryFolders:${theme.reset} ${options.uniqueGalleryFolders ?? detected.uniqueGalleryFolders}`);
  console.log(`  ${theme.muted}includeLorebook:${theme.reset} ${options.includeLorebook ?? detected.includeLorebook}`);
  console.log(`  ${theme.muted}includeChats:${theme.reset} ${options.includeChats}`);
  console.log("");

  const startedAt = Date.now();
  const summary = await runGalleryAudit(
    {
      stDataDir: dataDir,
      outDir,
      includeChats: options.includeChats,
      includeLorebook: options.includeLorebook,
      uniqueGalleryFolders: options.uniqueGalleryFolders,
      concurrency: options.concurrency,
    },
    {
      progress: (event) => {
        if (event.total === 0) return;
        const pct = Math.round((event.current / event.total) * 100);
        process.stdout.write(`\r  ${theme.muted}${event.stage.padEnd(14)}${theme.reset} ${String(event.current).padStart(7)}/${event.total}  ${pct}%   `);
        if (event.current >= event.total) process.stdout.write("\n");
      },
    },
  );

  printDivider();
  console.log(
    formatSummary(summary)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  printSummary(
    "Audit complete",
    [
      { label: "Characters discovered", value: String(summary.cards.total) },
      { label: "Gallery folders on disk", value: String(summary.folders.onDisk) },
      { label: "Non-empty folders", value: String(summary.folders.nonEmpty) },
      { label: "External URLs", value: `${summary.urls.unique} unique / ${summary.urls.instances} refs` },
      { label: "Unique local matches", value: String(summary.urls.uniqueMatched) },
      { label: "Ambiguous matches", value: String(summary.urls.ambiguous) },
      { label: "Missing matches", value: String(summary.urls.missing) },
      { label: "Characters ready", value: String(summary.readyCharacters) },
      { label: "Errors", value: String(summary.errors) },
      { label: "Duration", value: `${((Date.now() - startedAt) / 1000).toFixed(1)}s` },
    ],
    [
      `No files were modified. Reports: ${outDir}`,
      summary.errors > 0 ? `${summary.errors} error(s) — see gallery-audit-errors.txt` : "",
    ].filter(Boolean),
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`${theme.error}${error instanceof Error ? error.message : String(error)}${theme.reset}`);
    process.exit(1);
  }
}
