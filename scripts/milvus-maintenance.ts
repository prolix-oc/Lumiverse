#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  connectMilvusMaintenance, MilvusMaintenance, milvusConnectionIdentity,
  parseMilvusCheckpoint,
  type MilvusCanonicalRepair, type MilvusCheckpoint,
} from "../src/services/vector-store/providers/milvus-maintenance";
import type { CollectionName } from "../src/services/vector-store/types";

const HELP = `Milvus maintenance (Bun)

  bun run milvus:maintenance inventory [--collection embeddings|embeddings_world_books]
  bun run milvus:maintenance plan-text --collection NAME --checkpoint FILE
  bun run milvus:maintenance plan-bm25 --collection NAME --checkpoint FILE
  bun run milvus:maintenance run --checkpoint FILE --writers-stopped
  bun run milvus:maintenance cutover --checkpoint FILE --writers-stopped
  bun run milvus:maintenance rollback --checkpoint FILE --writers-stopped

Connection: LUMIVERSE_MILVUS_ADDRESS, LUMIVERSE_MILVUS_USERNAME,
LUMIVERSE_MILVUS_PASSWORD, LUMIVERSE_MILVUS_DATABASE, LUMIVERSE_MILVUS_SSL.
Alternatively pass --address, --database, --username, --ssl (password stays in env).
--canonical-rows FILE supplies JSONL {sourceHash,row} from canonical rebuilt data.
Use the same repair file for planning, resume, cutover, and rollback.
--timeout-ms defaults to 600000. Inventory/planning do not alter collection schemas.
Text requires StorageV3; in-place BM25 also requires schema/storage compaction.
Stop every writer for run/cutover/rollback. Restart Lumiverse after routing changes.
Old collections are retained. A checkpoint is bound to one endpoint/database/user.
`;

async function main() {
  const { values, positionals } = parseArgs({ options: {
    help: { type: "boolean" }, address: { type: "string" }, database: { type: "string" }, username: { type: "string" }, ssl: { type: "boolean" },
    collection: { type: "string" }, checkpoint: { type: "string" }, "writers-stopped": { type: "boolean" },
    "canonical-rows": { type: "string" }, "timeout-ms": { type: "string" },
  }, allowPositionals: true });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  if (!["inventory", "plan-text", "plan-bm25", "run", "cutover", "rollback"].includes(command)) throw new Error("Unknown maintenance command. Use --help.");
  const collection = values.collection;
  if (collection && collection !== "embeddings" && collection !== "embeddings_world_books") throw new Error("Invalid collection.");
  if (command.startsWith("plan-") && !collection) throw new Error("--collection is required for planning.");
  if (command !== "inventory" && !values.checkpoint) throw new Error("--checkpoint is required.");
  if (["run", "cutover", "rollback"].includes(command) && !values["writers-stopped"]) throw new Error("Stop all Lumiverse instances and other writers, then pass --writers-stopped.");
  const config = {
    address: values.address ?? process.env.LUMIVERSE_MILVUS_ADDRESS ?? "",
    database: values.database ?? process.env.LUMIVERSE_MILVUS_DATABASE,
    username: values.username ?? process.env.LUMIVERSE_MILVUS_USERNAME,
    ssl: values.ssl ?? process.env.LUMIVERSE_MILVUS_SSL === "true",
    requestTimeoutMs: 60_000,
  };
  if (!config.address) throw new Error("Set LUMIVERSE_MILVUS_ADDRESS or --address.");
  const timeoutMs = Number(values["timeout-ms"] ?? 600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("Invalid --timeout-ms (1..86400000).");
  const path = values.checkpoint ? resolve(values.checkpoint) : undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    lock = await open(`${path}.lock`, "wx", 0o600).catch(() => { throw new Error(`Checkpoint locked: ${path}.lock. Verify the prior process has stopped before removing a stale lock.`); });
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
  let client: Awaited<ReturnType<typeof connectMilvusMaintenance>> | undefined;
  let state: MilvusCheckpoint | undefined;
  const save = async (checkpoint: MilvusCheckpoint) => {
    if (!path) throw new Error("Checkpoint path missing.");
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(checkpoint, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    console.error(JSON.stringify({ phase: checkpoint.phase, copied: checkpoint.copied, rows: checkpoint.rowCount, progress: checkpoint.progress }));
  };
  try {
    const repairs = new Map<string, MilvusCanonicalRepair>();
    if (values["canonical-rows"]) {
      const lines = createInterface({ input: createReadStream(values["canonical-rows"]), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const repair = JSON.parse(line) as MilvusCanonicalRepair;
        if (!repair?.row?.id || typeof repair.sourceHash !== "string" || repairs.has(repair.row.id)) throw new Error("Invalid or duplicate canonical repair.");
        repairs.set(repair.row.id, repair);
      }
    }
    client = await connectMilvusMaintenance(config, process.env.LUMIVERSE_MILVUS_PASSWORD ?? null);
    const maintenance = new MilvusMaintenance(client, milvusConnectionIdentity(config), save, repairs, { timeoutMs });
    if (command === "inventory") {
      const collections: CollectionName[] = collection ? [collection as CollectionName] : ["embeddings", "embeddings_world_books"];
      console.log(JSON.stringify(await Promise.all(collections.map((name) => maintenance.inventory(name))), null, 2));
      return;
    }
    if (command.startsWith("plan-")) {
      try { await readFile(path!); throw new Error("Checkpoint already exists. Choose a new path or resume the existing operation."); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      state = command === "plan-text" ? await maintenance.planText(collection as CollectionName) : await maintenance.planBackfill(collection as CollectionName);
      await save(state);
    } else {
      state = parseMilvusCheckpoint(JSON.parse(await readFile(path!, "utf8")));
      if (command === "run") {
        if (state!.kind === "text") await maintenance.copyText(state!);
        else await maintenance.backfill(state!);
      } else if (command === "cutover") await maintenance.cutover(state!);
      else await maintenance.rollback(state!);
    }
    console.log(JSON.stringify(state, null, 2));
  } catch (error) {
    if (state) { state.error = error instanceof Error ? error.message : String(error); await save(state); }
    throw error;
  } finally {
    try { await client?.closeConnection(); }
    finally { if (lock) { await lock.close(); await unlink(`${path}.lock`); } }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
