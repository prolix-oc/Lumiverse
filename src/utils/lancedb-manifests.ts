import { constants, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const U64_MAX = (1n << 64n) - 1n;

/**
 * Repair a local table that Lance cannot open because its manifest names mix
 * V1 and V2. Call only with writers excluded and native reads drained.
 *
 * Lance's migrateManifestPathsV2() requires an already-open table. This uses
 * the same filename mapping without opening the broken table:
 * https://lance.org/format/table/transaction/#manifest-naming-schemes
 * No manifest contents, fragments, or indexes are rewritten.
 */
export function repairMixedLanceManifestPaths(tableDir: string): { migrated: number; backupPath: string | null } {
  const versionsDir = join(tableDir, "_versions");
  const entries = readdirSync(versionsDir, { withFileTypes: true });
  const v1: string[] = [];
  const v2 = new Set<string>();
  for (const entry of entries) {
    const match = /^(\d+)\.manifest$/.exec(entry.name);
    if (!match) continue; // Ignore staging files, version hints, and detached versions.
    const number = BigInt(match[1]!);
    if (!entry.isFile() || number > U64_MAX || match[1]!.length > 20) {
      throw new Error(`Invalid LanceDB manifest: ${join(versionsDir, entry.name)}`);
    }
    if (match[1]!.length === 20) {
      v2.add(entry.name);
    } else {
      if (number === 0n || String(number) !== match[1]) {
        throw new Error(`Noncanonical LanceDB manifest: ${join(versionsDir, entry.name)}`);
      }
      v1.push(entry.name);
    }
  }
  // Healthy legacy tables are supported by Lance; do not migrate them merely
  // because the SDK defaults to V2 for new tables. Also makes retries a no-op.
  if (v1.length === 0 || v2.size === 0) return { migrated: 0, backupPath: null };

  const moves = v1.map((name) => {
    const version = BigInt(name.slice(0, -".manifest".length));
    const target = `${(U64_MAX - version).toString().padStart(20, "0")}.manifest`;
    const sourcePath = join(versionsDir, name);
    const targetPath = join(versionsDir, target);
    const duplicate = v2.has(target);
    // Validate every collision BEFORE changing any filenames. Different
    // contents may represent divergent histories; choosing one loses data.
    if (duplicate && !readFileSync(sourcePath).equals(readFileSync(targetPath))) {
      throw new Error(`Conflicting LanceDB manifests for version ${version}: ${sourcePath} and ${targetPath}; manual recovery required`);
    }
    return { name, sourcePath, targetPath, duplicate };
  });

  // Keep every original V1 manifest outside Lance's _versions listing. Finish
  // the backup before moving anything. A failed/interrupted pass can be retried:
  // each rename is atomic, and any remaining mixed names are repaired next time.
  const backupPath = mkdtempSync(join(tableDir, ".manifest-v1-backup-"));
  try {
    for (const move of moves) {
      copyFileSync(move.sourcePath, join(backupPath, move.name), constants.COPYFILE_EXCL);
    }
    for (const move of moves) {
      if (move.duplicate) {
        unlinkSync(move.sourcePath); // Identical V2 file and original backup both exist.
      } else {
        if (existsSync(move.targetPath)) {
          throw new Error(`LanceDB manifest appeared during recovery: ${move.targetPath}`);
        }
        renameSync(move.sourcePath, move.targetPath);
      }
    }
  } catch (cause) {
    throw new Error(`LanceDB manifest repair interrupted; files preserved in ${versionsDir} and ${backupPath}`, { cause });
  }
  return { migrated: moves.length, backupPath };
}
