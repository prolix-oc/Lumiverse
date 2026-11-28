/**
 * Benchmark the production migration and service against long-card fixtures.
 * bun --no-env-file scripts/bench-character-content-search.ts /path/to/corpus.sqlite [count]
 * Input is the read-only corpus made by bench-character-search.ts prepare.
 * All writes go to a new temporary directory. Output contains aggregates only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { encode, decode } from "gpt-tokenizer/encoding/cl100k_base";

const source = process.argv[2];
const count = Number(process.argv[3] ?? 1000);
assert(source, "Provide the prepared corpus.sqlite path");
assert(Number.isInteger(count) && count >= 10 && count <= 2000, "count must be between 10 and 2000");
const output = mkdtempSync(join(tmpdir(), "lumiverse-content-search-"));
process.env.DATA_DIR = output;
const { initDatabase, closeDatabase } = await import("../src/db/connection");
const { listCharacterSummaries } = await import("../src/services/characters.service");
const baseline = readFileSync(new URL("../src/db/baseline.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../src/db/migrations/137_character_content_search.sql", import.meta.url), "utf8");
const donor = new Database(resolve(source), { readonly: true });
const path = join(output, "fixture.sqlite");
const db = initDatabase(path);
const round = (n: number) => +n.toFixed(3);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: round(sorted[Math.floor(sorted.length * .5)]), p95: round(sorted[Math.floor(sorted.length * .95)]), max: round(sorted.at(-1)!) };
};
function measure(fn: () => unknown) {
  const start = performance.now(); fn(); return performance.now() - start;
}
function size() { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); return statSync(path).size; }
function queries(searchIn: "metadata" | "all") {
  return ["name", "recent", "created", "most_chats", "discover", undefined].map(sort => {
    const times: number[] = [];
    let total = 0;
    for (let i = 0; i < 24; i++) {
      const ms = measure(() => {
        const page = listCharacterSummaries("bench", { limit: 60, offset: 60 }, { searchIn, search: searchIn === "all" ? "friend" : "Fixture", sort, seed: 10 });
        total = page.total;
        assert.equal(total, count);
        assert.equal(page.data.length, Math.min(60, Math.max(0, count - 60)));
      });
      if (i >= 4) times.push(ms);
    }
    return { sort: sort ?? "relevance", total, milliseconds: stats(times) };
  });
}

try {
  db.run(baseline.slice(0, baseline.indexOf("-- Full-content search keeps")));
  db.run("INSERT INTO user(id,name,email) VALUES('bench','Benchmark','benchmark@example.invalid')");
  const rows = donor.query("SELECT name,creator,tags,description,personality,scenario,first_mes,mes_example,creator_notes FROM characters LIMIT ?").all(count) as Record<string, string>[];
  assert.equal(rows.length, count);
  const insert = db.query(`INSERT INTO characters(id,user_id,name,creator,tags,description,personality,scenario,first_mes,creator_notes,extensions,created_at,updated_at)
    VALUES(?,'bench',?,?,?,?,?,?,?,?,?,1,1)`);
  const tokenLengths: number[] = [];
  console.log(JSON.stringify({ phase: "preparing-long-cards", count, output }));
  db.transaction(() => {
    rows.forEach((row, i) => {
      const target = 4000 + Math.round(i / (count - 1) * 11000);
      const original = [row.description, row.personality, row.scenario, row.first_mes, row.mes_example, row.creator_notes].filter(Boolean).join("\n") || "A traveler meets a friend in a quiet village. ";
      const donorTokens = encode(original, { disallowedSpecial: new Set() });
      const tokens = Array.from({ length: target }, (_, index) => donorTokens[index % donorTokens.length]);
      const part = (start: number, end: number) => decode(tokens.slice(Math.floor(target * start), Math.floor(target * end)));
      const description = "friend " + part(0, .5);
      const personality = part(.5, .6), scenario = part(.6, .7);
      const greeting = part(.7, .9) + (i === count - 1 ? " tailgreetingneedle" : "");
      const notes = part(.9, .95) + (i === count - 1 ? " tailnotesneedle" : "");
      const variant = part(.95, 1) + (i === count - 1 ? " tailvariantneedle" : "");
      tokenLengths.push(encode([description, personality, scenario, greeting, notes, variant].join("\n"), { disallowedSpecial: new Set() }).length);
      insert.run(`card-${i}`, `Fixture ${i} ${row.name}`, row.creator, row.tags, description, personality, scenario, greeting, notes,
        JSON.stringify({ alternate_fields: { description: [{ label: "Long variant", content: variant }] } }));
    });
  })();
  donor.close();
  const chat = db.query("INSERT INTO chats(id,user_id,character_id,name,updated_at) VALUES(?,'bench',?,'Fixture chat',?)");
  db.transaction(() => { for (let i = 0; i < count * 3; i++) chat.run(`chat-${i}`, `card-${i % count}`, i); })();
  const beforeBytes = size();
  const metadataBefore = queries("metadata");
  const migrationMs = measure(() => db.transaction(() => db.run(migration))());
  const afterBytes = size();
  const metadataAfter = queries("metadata"), allFields = queries("all");
  for (const term of ["tailgreetingneedle", "tailnotesneedle", "tailvariantneedle"]) {
    const matches = listCharacterSummaries("bench", { limit: 60, offset: 0 }, { searchIn: "all", search: term, sort: "name" });
    assert.deepEqual(matches.data.map(row => row.id), [`card-${count - 1}`]);
  }
  const saveTimes: number[] = [], unchangedTimes: number[] = [], folderTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    saveTimes.push(measure(() => db.run("UPDATE characters SET creator_notes=creator_notes || ? WHERE id=?", [` edit${i}`, `card-${count - 1}`])));
    unchangedTimes.push(measure(() => db.run("UPDATE characters SET description=description,creator_notes=creator_notes WHERE id=?", [`card-${count - 1}`])));
    folderTimes.push(measure(() => db.run("UPDATE characters SET folder=? WHERE id=?", [`Folder ${i}`, `card-${count - 1}`])));
  }
  db.run("INSERT INTO characters_content_fts(characters_content_fts,rank) VALUES('integrity-check',1)");
  db.run("DELETE FROM characters WHERE id=?", [`card-${count - 1}`]);
  assert.equal(listCharacterSummaries("bench", { limit: 60, offset: 0 }, { searchIn: "all", search: "tailnotesneedle", sort: "name" }).total, 0);
  db.run("INSERT INTO characters_content_fts(characters_content_fts,rank) VALUES('integrity-check',1)");
  const result = {
    fixture: { cards: count, chats: count * 3, tokenizer: "cl100k_base", minTokens: Math.min(...tokenLengths), maxTokens: Math.max(...tokenLengths), cpu: cpus()[0].model, bun: Bun.version },
    databaseBytes: { before: beforeBytes, after: afterBytes, growth: afterBytes - beforeBytes }, migrationMs: round(migrationMs),
    metadataBefore, metadataAfter, allFields,
    writesMs: { editLongestCard: stats(saveTimes), unchangedSave: stats(unchangedTimes), folder: stats(folderTimes) },
    correctness: "long-field tails, updates, deletion, and FTS integrity passed",
    limits: "Local warmed SQL page+count; excludes HTTP, browser rendering, cold disk, concurrent writes, and slower devices.",
  };
  writeFileSync(join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, ...result }, null, 2));
} finally { closeDatabase(); }
// Imported services own background timers; this standalone benchmark is done.
process.exit(0);
