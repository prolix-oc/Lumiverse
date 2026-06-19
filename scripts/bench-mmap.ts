#!/usr/bin/env bun
/**
 * Lumiverse SQLite mmap_size Benchmark
 *
 * Measures the real-world cost/benefit of `PRAGMA mmap_size` on this host's
 * filesystem, so you can decide whether to keep memory-mapped I/O enabled.
 * It replicates the exact pragma profile from `src/db/maintenance.ts`
 * (WAL, synchronous=NORMAL, 64 MiB cache, foreign_keys=ON, etc.) and varies
 * ONLY `mmap_size` between runs.
 *
 * Run with:
 *   bun run scripts/bench-mmap.ts                 # defaults (mmap 0 / 256 / 2048 MiB)
 *   bun run scripts/bench-mmap.ts --rows=500000   # heavier batch
 *   bun run scripts/bench-mmap.ts --mmap=0,256    # compare specific sizes (MiB)
 *   bun run scripts/bench-mmap.ts --dir=./data    # run on a specific volume/FS
 *   bun run scripts/bench-mmap.ts --json          # machine-readable output
 *
 * Flags:
 *   --rows=N            rows to bulk-insert per run        (default 300000)
 *   --chats=N           parent rows for FK targets         (default rows/300)
 *   --batch=N           inserts per transaction            (default 1000)
 *   --iterations=N      timed iterations per config        (default 5, +1 warmup)
 *   --mmap=a,b,c        mmap_size values in MiB to compare (default 0,256,2048)
 *   --reads=N           random point lookups per run       (default 50000)
 *   --scans=N           indexed range scans per run        (default 5000)
 *   --no-autocheckpoint disable auto-checkpoint during inserts to isolate the
 *                       big-checkpoint write-back cost      (default: realistic, on)
 *   --dir=PATH          where to create the temp DB        (default: OS tmpdir)
 *   --keep              do not delete the temp DB afterward
 *   --json              emit raw results as JSON
 *   --help              show this help
 *
 * What it measures, per mmap_size:
 *   insert      bulk INSERT throughput (the batch-write question)
 *   checkpoint  explicit wal_checkpoint(TRUNCATE) — the only write path mmap touches
 *   point-read  random SELECT by primary key (SQLite-cache-cold)
 *   range-scan  indexed range scans over a parent's children
 *
 * NOTE: mmap_size governs the MAIN DB file only. In WAL mode, INSERT/UPDATE
 * traffic lands in the -wal file via pwrite() regardless, so the insert delta
 * is expected to be ~nil; mmap mainly affects cache-cold reads.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;

// ─── Args ─────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq === -1 ? "true" : hit.slice(eq + 1);
}
const has = (name: string) => process.argv.includes(`--${name}`);

if (has("help")) {
  console.log(
    (await Bun.file(import.meta.path).text())
      .split("\n")
      .filter((l) => l.startsWith(" *") || l.startsWith("/**"))
      .map((l) => l.replace(/^\/?\*\*?/, "").replace(/^ /, ""))
      .join("\n"),
  );
  process.exit(0);
}

const ROWS = Number(arg("rows", "300000"));
const CHATS = Number(arg("chats", String(Math.max(50, Math.floor(ROWS / 300)))));
const BATCH = Number(arg("batch", "1000"));
const ITERATIONS = Number(arg("iterations", "5"));
const READS = Number(arg("reads", "50000"));
const SCANS = Number(arg("scans", "5000"));
const MMAP_MIBS = (arg("mmap", "0,256,2048") as string).split(",").map((s) => Number(s.trim()));
const AUTOCHECKPOINT = !has("no-autocheckpoint");
const KEEP = has("keep");
const JSON_OUT = has("json");
const BASE_DIR = arg("dir", tmpdir()) as string;
const WORK_DIR = join(BASE_DIR, `lumiverse-mmap-bench-${process.pid}-${Date.now()}`);

// ─── Tiny ANSI (self-contained so the script is portable) ───────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const ms = (ns: number) => ns / 1_000_000;
const fmtMs = (v: number) => `${v.toFixed(1)} ms`;
const fmtBytes = (b: number) => `${(b / MiB).toFixed(1)} MiB`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ─── Workload ────────────────────────────────────────────────────────────

const LOREM =
  "The lamplight pooled on the cobbles as she turned the corner, breath fogging in the cold. " +
  "Somewhere behind the shuttered windows a radio murmured, half a song, half static. ";

function makeContent(i: number): string {
  // ~900 chars, varied by index so pages aren't trivially compressible/identical.
  const reps = 5 + (i % 4);
  return `#${i} ` + LOREM.repeat(reps).slice(0, 880);
}
function makeMetadata(i: number): string {
  return JSON.stringify({
    model: i % 2 ? "claude-opus-4-8" : "claude-sonnet-4-6",
    tokens: 200 + (i % 800),
    reasoning: i % 3 === 0,
    finishedAt: 1748000000 + i,
  });
}

const PRAGMAS = (mmapBytes: number, autocheckpoint: boolean): string[] => [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  `PRAGMA cache_size = ${-Math.floor((64 * MiB) / 1024)}`, // 64 MiB, matches DEFAULT_CACHE_BYTES
  "PRAGMA temp_store = MEMORY",
  `PRAGMA mmap_size = ${mmapBytes}`,
  `PRAGMA wal_autocheckpoint = ${autocheckpoint ? 500 : 0}`,
  `PRAGMA journal_size_limit = ${64 * MiB}`,
];

function open(path: string, mmapBytes: number, autocheckpoint: boolean): Database {
  const db = new Database(path);
  for (const p of PRAGMAS(mmapBytes, autocheckpoint)) db.run(p);
  return db;
}

const SCHEMA = `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    token_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);
  CREATE INDEX idx_messages_role ON messages(role);
`;

interface RunResult {
  insertNs: number;
  checkpointNs: number;
  pointReadNs: number;
  rangeScanNs: number;
  walBeforeCheckpoint: number;
  dbBytes: number;
  effectiveMmap: number;
}

function runOnce(dbPath: string, mmapBytes: number): RunResult {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }

  const db = open(dbPath, mmapBytes, AUTOCHECKPOINT);
  const effectiveMmap = Number((db.query("PRAGMA mmap_size").get() as any).mmap_size) || 0;
  db.run(SCHEMA);

  // Parent rows (FK targets) — not timed.
  const chatIds: string[] = [];
  db.run("BEGIN");
  const insChat = db.query("INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < CHATS; i++) {
    const id = crypto.randomUUID();
    chatIds.push(id);
    insChat.run(id, `chat ${i}`, 1748000000 + i);
  }
  db.run("COMMIT");

  // ── INSERT (the batch-write measurement) ──
  // Random UUIDs => scattered B-tree writes (the page pattern most relevant to mmap).
  const sampleIds: string[] = [];
  const stride = Math.max(1, Math.floor(ROWS / 20000)); // keep ~20k ids for the read phase
  const insMsg = db.query(
    "INSERT INTO messages (id, chat_id, role, content, metadata, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const t0 = Bun.nanoseconds();
  let inTxn = false;
  for (let i = 0; i < ROWS; i++) {
    if (i % BATCH === 0) {
      if (inTxn) db.run("COMMIT");
      db.run("BEGIN");
      inTxn = true;
    }
    const id = crypto.randomUUID();
    if (i % stride === 0) sampleIds.push(id);
    insMsg.run(
      id,
      chatIds[i % CHATS],
      i % 2 ? "assistant" : "user",
      makeContent(i),
      makeMetadata(i),
      200 + (i % 800),
      1748000000 + i,
    );
  }
  if (inTxn) db.run("COMMIT");
  const insertNs = Bun.nanoseconds() - t0;

  // ── CHECKPOINT (only write path mmap touches) ──
  const walBeforeCheckpoint = existsSync(dbPath + "-wal") ? statSync(dbPath + "-wal").size : 0;
  const tC = Bun.nanoseconds();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const checkpointNs = Bun.nanoseconds() - tC;

  const dbBytes = statSync(dbPath).size;
  db.close();

  // ── READS on a FRESH connection (SQLite page cache cold; OS cache stays warm) ──
  const rdb = open(dbPath, mmapBytes, AUTOCHECKPOINT);
  const getById = rdb.query("SELECT content, token_count FROM messages WHERE id = ?");
  const tR = Bun.nanoseconds();
  for (let i = 0; i < READS; i++) {
    getById.get(sampleIds[(i * 2654435761) % sampleIds.length]); // Knuth hash for spread
  }
  const pointReadNs = Bun.nanoseconds() - tR;

  const scanByChat = rdb.query(
    "SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at LIMIT 50",
  );
  const tS = Bun.nanoseconds();
  for (let i = 0; i < SCANS; i++) {
    scanByChat.all(chatIds[(i * 40503) % chatIds.length]);
  }
  const rangeScanNs = Bun.nanoseconds() - tS;
  rdb.close();

  return { insertNs, checkpointNs, pointReadNs, rangeScanNs, walBeforeCheckpoint, dbBytes, effectiveMmap };
}

// ─── Drive it ────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const dbPath = join(WORK_DIR, "bench.db");

  if (!JSON_OUT) {
    console.log(c.bold(c.cyan("\n  Lumiverse SQLite mmap_size benchmark")));
    console.log(
      c.dim(
        `  rows=${ROWS.toLocaleString()}  chats=${CHATS}  batch=${BATCH}  iterations=${ITERATIONS} (+1 warmup)\n` +
          `  reads=${READS.toLocaleString()}  scans=${SCANS.toLocaleString()}  autocheckpoint=${AUTOCHECKPOINT ? "on(500)" : "OFF"}\n` +
          `  mmap sizes (MiB)=[${MMAP_MIBS.join(", ")}]\n` +
          `  workdir=${WORK_DIR}`,
      ),
    );
  }

  const results: Record<number, RunResult> = {};
  for (const mib of MMAP_MIBS) {
    const bytes = mib * MiB;
    if (!JSON_OUT) process.stdout.write(c.dim(`\n  mmap=${mib} MiB  `));
    runOnce(dbPath, bytes); // warmup, discarded
    const acc: RunResult[] = [];
    for (let it = 0; it < ITERATIONS; it++) {
      acc.push(runOnce(dbPath, bytes));
      if (!JSON_OUT) process.stdout.write(c.dim("."));
    }
    results[mib] = {
      insertNs: median(acc.map((r) => r.insertNs)),
      checkpointNs: median(acc.map((r) => r.checkpointNs)),
      pointReadNs: median(acc.map((r) => r.pointReadNs)),
      rangeScanNs: median(acc.map((r) => r.rangeScanNs)),
      walBeforeCheckpoint: median(acc.map((r) => r.walBeforeCheckpoint)),
      dbBytes: acc[acc.length - 1].dbBytes,
      effectiveMmap: acc[acc.length - 1].effectiveMmap,
    };
  }

  if (!KEEP) rmSync(WORK_DIR, { recursive: true, force: true });

  if (JSON_OUT) {
    console.log(JSON.stringify({ config: { ROWS, CHATS, BATCH, ITERATIONS, READS, SCANS, AUTOCHECKPOINT }, results }, null, 2));
    return;
  }

  // ── Report ──
  const baseline = MMAP_MIBS.includes(0) ? 0 : MMAP_MIBS[0]; // compare against mmap-off if present
  const sample = results[MMAP_MIBS[0]];
  console.log(
    c.dim(
      `\n\n  DB file ≈ ${fmtBytes(sample.dbBytes)}   WAL before checkpoint ≈ ${fmtBytes(sample.walBeforeCheckpoint)}` +
        (sample.effectiveMmap !== MMAP_MIBS[0] * MiB && MMAP_MIBS[0] !== 0
          ? c.yellow(`   (note: kernel reported mmap=${fmtBytes(sample.effectiveMmap)})`)
          : ""),
    ),
  );

  const phases: Array<[keyof RunResult, string]> = [
    ["insertNs", "insert (batch write)"],
    ["checkpointNs", "checkpoint(TRUNCATE)"],
    ["pointReadNs", "point-read (random PK)"],
    ["rangeScanNs", "range-scan (indexed)"],
  ];

  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log("\n  " + c.bold(pad("phase", 24)) + MMAP_MIBS.map((m) => padL(`${m}MiB`, 14)).join("") + padL("Δ vs off", 16));
  console.log("  " + c.dim("─".repeat(24 + MMAP_MIBS.length * 14 + 16)));

  for (const [key, label] of phases) {
    const cells = MMAP_MIBS.map((m) => padL(fmtMs(ms(results[m][key] as number)), 14)).join("");
    const base = results[baseline][key] as number;
    const cmp = MMAP_MIBS.find((m) => m !== baseline);
    let delta = "";
    if (cmp != null) {
      const pct = (((results[cmp][key] as number) - base) / base) * 100;
      const sign = pct >= 0 ? "+" : "";
      const colored = Math.abs(pct) < 3 ? c.dim : pct > 0 ? c.red : c.green;
      delta = colored(`${sign}${pct.toFixed(1)}% (${cmp}MiB)`);
      delta = padL(delta, 16 + (colored("x").length - 1));
    }
    console.log("  " + pad(label, 24) + cells + delta);
  }

  // ── Verdict ──
  const off = results[baseline];
  const on = MMAP_MIBS.find((m) => m !== baseline);
  if (on != null) {
    const insertPct = ((results[on].insertNs - off.insertNs) / off.insertNs) * 100;
    const ckptPct = ((results[on].checkpointNs - off.checkpointNs) / off.checkpointNs) * 100;
    const readPct = ((results[on].pointReadNs - off.pointReadNs) / off.pointReadNs) * 100;
    console.log(c.bold("\n  Verdict (mmap on vs off):"));
    const line = (label: string, pct: number, lowerIsBetter = true) => {
      const better = lowerIsBetter ? pct < -3 : pct > 3;
      const worse = lowerIsBetter ? pct > 3 : pct < -3;
      const tag = better ? c.green("mmap faster") : worse ? c.red("mmap slower") : c.dim("no real difference");
      console.log(`    ${pad(label, 22)} ${padL(`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, 8)}  ${tag}`);
    };
    line("batch insert", insertPct);
    line("checkpoint", ckptPct);
    line("point reads", readPct);
    console.log(
      c.dim(
        "\n  Interpretation: a small/zero insert delta confirms writes are bound by WAL pwrite,\n" +
          "  not the memory map. Any meaningful win shows up in reads. Decide accordingly.\n",
      ),
    );
  }
}

main().catch((err) => {
  console.error(c.red("\nBenchmark failed:"), err);
  try {
    if (!KEEP) rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
