/**
 * Private-corpus character-search SQL benchmark. Never opens an application DB.
 *
 * bun --no-env-file scripts/bench-character-search.ts prepare /path/to/cards /tmp/new-directory
 * bun --no-env-file scripts/bench-character-search.ts bench /tmp/new-directory original [limit]
 * bun --no-env-file scripts/bench-character-search.ts bench /tmp/new-directory enriched [limit]
 * bun --no-env-file scripts/bench-character-search.ts selftest
 *
 * Keeps card text in disposable SQLite files; JSON results contain aggregates only.
 * SQL page shape, summary columns, and recent-chat join are read from the current
 * service source, with page+conditional-count behavior matching pagination.ts.
 * Timings exclude HTTP, JSON encoding, avatars, and concurrent application work.
 */
import assert from "node:assert/strict";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { extractPngTextChunk, parseCardJson } from "../src/services/character-card.service";

const [command, arg1, arg2, arg3] = process.argv.slice(2);
const MiB = 2 ** 20;
const direct = ["description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions"];
const metadata = ["name", "creator", "tags"];
const body = [...direct, "greetings", "variants"];
const allColumns = [...metadata, ...body];
const watched = [...metadata, ...direct, "alternate_greetings", "extensions"];
const baseline = readFileSync(new URL("../src/db/baseline.sql", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/characters.service.ts", import.meta.url), "utf8");
const summaryColumns = service.match(/const SUMMARY_COLUMNS = `([\s\S]*?)`;/)![1];
const recentJoin = service.match(/const chatRecencyJoin = `([\s\S]*?)`;/)![1];
let pngBytesRead = 0;

function log(value: unknown) { console.log(JSON.stringify(value)); }
function rounded(n: number) { return +n.toFixed(3); }
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
  return { samples: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) };
}
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now(); const value = fn();
  return { value, ms: rounded(performance.now() - start) };
}
function openDb(path: string) {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=500");
  // FTS5 internal external-content reads disallow nested virtual tables (such
  // as json_each). Scalar extraction keeps the prototype's source view valid.
  db.function("benchmark_greetings", { deterministic: true }, (value: string) =>
    JSON.parse(value).filter((entry: unknown) => typeof entry === "string").join("\n"));
  db.function("benchmark_variants", { deterministic: true }, (value: string) => {
    const fields = JSON.parse(value).alternate_fields ?? {};
    return ["description", "personality", "scenario"].flatMap(key => Array.isArray(fields[key]) ? fields[key] : [])
      .filter((entry: unknown) => entry && typeof entry === "object")
      .flatMap((entry: any) => [entry.label, entry.content].filter(v => typeof v === "string")).join("\n");
  });
  return db;
}
function removeSearch(db: Database) {
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'characters_fts_%' OR name LIKE 'bench_%')").all() as { name: string }[]) {
    assert(/^[a-z_]+$/.test(row.name)); db.run(`DROP TRIGGER ${row.name}`);
  }
  db.run("DROP TABLE IF EXISTS characters_fts; DROP TABLE IF EXISTS characters_body_fts; DROP VIEW IF EXISTS character_search_source");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
}
function newLibrary(path: string) {
  assert(!existsSync(path), `Refusing to replace ${path}`);
  const db = openDb(path);
  // Prototype comparisons install their own indexes below, excluding the
  // production content index so it cannot distort size or write measurements.
  db.run(baseline.slice(0, baseline.indexOf("-- Full-content search keeps")));
  removeSearch(db);
  db.run("INSERT INTO user(id,name,email,role) VALUES('bench','Benchmark','benchmark@example.invalid','owner')");
  return db;
}
function walk(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(path, entry.name)) : entry.name.toLowerCase().endsWith(".png") ? [join(path, entry.name)] : []);
}

// Seek past image chunks instead of reading tens of GB of avatar pixels. Reuse
// the production PNG text decoder and V1/V2/V3 card mapper on text-only chunks.
function readCard(path: string) {
  const fd = openSync(path, "r");
  function read(length: number, position: number) {
    const buffer = Buffer.alloc(length);
    assert.equal(readSync(fd, buffer, 0, length, position), length);
    pngBytesRead += length; return buffer;
  }
  try {
    const size = fstatSync(fd).size;
    const signature = read(8, 0);
    assert(signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    const chunks = [signature];
    let offset = 8;
    while (offset + 12 <= size) {
      const header = read(8, offset), length = header.readUInt32BE(0), type = header.toString("ascii", 4);
      assert(offset + length + 12 <= size);
      if (["tEXt", "zTXt", "iTXt"].includes(type)) {
        assert(length <= 100 * MiB); chunks.push(header, read(length + 4, offset + 8));
      }
      offset += length + 12;
      if (type === "IEND") break;
    }
    const minimal = Buffer.concat(chunks);
    const encoded = extractPngTextChunk(minimal, "chara") ?? extractPngTextChunk(minimal, "ccv3");
    assert(encoded, "No card metadata");
    const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return { card: parseCardJson(raw), format: typeof raw.spec === "string" ? raw.spec : "v1" };
  } finally { closeSync(fd); }
}

function corpusStats(db: Database) {
  const columns = [...metadata, ...direct, "alternate_greetings", "extensions"];
  const sizes = db.query(`SELECT ${columns.map(c => `SUM(length(CAST(${c} AS BLOB))) AS ${c}`).join(",")} FROM characters`).get();
  const coverage = db.query(`SELECT COUNT(*) AS cards,
    SUM(creator!='') AS with_creator, SUM(creator_notes!='') AS with_notes,
    SUM(json_array_length(tags)>0) AS with_tags,
    SUM(json_array_length(alternate_greetings)>0) AS with_alternate_greetings,
    SUM(json_array_length(alternate_greetings)) AS alternate_greetings,
    SUM(json_type(extensions,'$.alternate_fields')='object') AS with_alternate_fields
    FROM characters`).get();
  const lengths = (db.query(`SELECT ${direct.map(c => `length(CAST(${c} AS BLOB))`).join("+")}+length(CAST(alternate_greetings AS BLOB))+length(CAST(extensions AS BLOB)) AS bytes FROM characters`).all() as { bytes: number }[]).map(r => r.bytes);
  return { coverage, fieldBytes: sizes, cardTextBytes: stats(lengths) };
}

async function prepare(source: string, output: string) {
  assert(!existsSync(output), "Preparation needs a new directory"); mkdirSync(output, { recursive: true });
  const paths = walk(source).sort(); assert(paths.length > 0);
  const db = newLibrary(join(output, "corpus.sqlite"));
  const columns = ["id", "user_id", ...metadata, ...direct, "alternate_greetings", "extensions", "created_at", "updated_at", "library_scope", "folder"];
  const insert = db.query(`INSERT INTO characters(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  const formats: Record<string, number> = {}, failures: Record<string, number> = {};
  let imported = 0;
  const start = performance.now();
  for (let first = 0; first < paths.length; first += 500) {
    db.transaction(() => {
      for (let i = first; i < Math.min(first + 500, paths.length); i++) {
        try {
          const { card, format } = readCard(paths[i]);
          const record = card as Record<string, any>;
          const values = [...metadata, ...direct].map(key => key === "tags"
            ? JSON.stringify(Array.isArray(record.tags) ? record.tags.filter((v: unknown) => typeof v === "string") : []) : String(record[key] ?? ""));
          insert.run(`card-${String(i).padStart(6, "0")}`, "bench", ...values,
            JSON.stringify((card.alternate_greetings ?? []).filter((v: unknown) => typeof v === "string")), JSON.stringify(card.extensions ?? {}),
            1_700_000_000 + i * 60, 1_700_000_000 + ((i * 7919) % paths.length) * 60,
            i % 5 === 0 ? "shared" : "mine", `Folder ${i % 20}`);
          imported++; formats[format] = (formats[format] ?? 0) + 1;
        } catch (error) {
          const reason = error instanceof Error ? error.name : "UnknownError";
          failures[reason] = (failures[reason] ?? 0) + 1;
        }
      }
    })();
    if (first % 5000 === 0) log({ phase: "extract", processed: Math.min(first + 500, paths.length), total: paths.length, seconds: rounded((performance.now() - start) / 1000) });
    await Bun.sleep(0);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const manifest = { source, files: paths.length, imported, failures, formats, pngBytesRead, preparationMs: rounded(performance.now() - start), ...corpusStats(db) };
  writeFileSync(join(output, "corpus-summary.json"), JSON.stringify(manifest, null, 2) + "\n");
  log({ phase: "prepared", output, ...manifest }); db.close();
}

function enrich(db: Database) {
  const donors = (db.query("SELECT first_mes,description FROM characters WHERE length(first_mes)+length(description)>400 ORDER BY id").all() as { first_mes: string; description: string }[]);
  assert(donors.length > 0);
  const rows = db.query("SELECT rowid,creator,creator_notes,tags,alternate_greetings,extensions,personality,scenario,mes_example,system_prompt,post_history_instructions FROM characters ORDER BY rowid").all() as any[];
  const update = db.query("UPDATE characters SET creator=?,creator_notes=?,tags=?,alternate_greetings=?,extensions=?,personality=?,scenario=?,mes_example=?,system_prompt=?,post_history_instructions=? WHERE rowid=?");
  const donor = (i: number, length: number) => {
    const source = donors[(i * 7919 + 31) % donors.length];
    return (source.first_mes + "\n" + source.description).slice(0, length);
  };
  db.transaction(() => {
    rows.forEach((row, i) => {
      const greetings = JSON.parse(row.alternate_greetings), extensions = JSON.parse(row.extensions), tags = JSON.parse(row.tags);
      if (!tags.length) tags.push(`Benchmark category ${i % 20}`, `Benchmark theme ${i % 31}`);
      if (i % 2 === 0) for (let j = 0; j < 3; j++) greetings.push(donor(i + j + 1, 1800));
      if (i % 100 === 0) for (let j = 0; j < 20; j++) greetings.push(donor(i + j + 101, 4000));
      if (i % 4 === 0) {
        extensions.alternate_fields ??= {};
        for (const [j, field] of ["description", "personality", "scenario"].entries()) {
          if (!Array.isArray(extensions.alternate_fields[field])) extensions.alternate_fields[field] = [];
          extensions.alternate_fields[field].push({ id: `benchmark-${i}-${j}`, label: `Benchmark variant ${j}`, content: donor(i + j + 201, 2400) });
        }
      }
      update.run(row.creator || `Benchmark author ${i % 2000}`, row.creator_notes || donor(i + 301, 1200),
        JSON.stringify(tags), JSON.stringify(greetings), JSON.stringify(extensions),
        row.personality || donor(i + 401, 1200), row.scenario || donor(i + 402, 800),
        row.mes_example || donor(i + 403, 800), row.system_prompt || donor(i + 404, 300),
        row.post_history_instructions || donor(i + 405, 200), row.rowid);
    });
  })();
}

function createView(db: Database) {
  db.run(`CREATE VIEW character_search_source AS SELECT c.rowid AS rowid,c.*,
    benchmark_greetings(c.alternate_greetings) AS greetings,
    benchmark_variants(c.extensions) AS variants
    FROM characters c`);
}

function addIndex(db: Database, index: string, columns: string[], source: string) {
  const joined = columns.join(",");
  db.run(`CREATE VIRTUAL TABLE ${index} USING fts5(${joined},content='${source}',content_rowid='rowid',tokenize='trigram')`);
  db.run(`INSERT INTO ${index}(${index}) VALUES('rebuild')`);
  const inputs = columns === metadata ? metadata : columns === body ? [...direct, "alternate_greetings", "extensions"] : watched;
  const changed = inputs.map(c => c === "extensions"
    ? "json_extract(old.extensions,'$.alternate_fields') IS NOT json_extract(new.extensions,'$.alternate_fields')" : `old.${c} IS NOT new.${c}`).join(" OR ");
  const deletion = `INSERT INTO ${index}(${index},rowid,${joined}) SELECT 'delete',rowid,${joined} FROM ${source} WHERE rowid=old.rowid;`;
  const insertion = `INSERT INTO ${index}(rowid,${joined}) SELECT rowid,${joined} FROM ${source} WHERE rowid=new.rowid;`;
  db.run(`CREATE TRIGGER bench_${index}_insert AFTER INSERT ON characters BEGIN ${insertion} END;
    CREATE TRIGGER bench_${index}_delete BEFORE DELETE ON characters BEGIN ${deletion} END;
    CREATE TRIGGER bench_${index}_before BEFORE UPDATE OF ${inputs.join(",")} ON characters WHEN ${changed} BEGIN ${deletion} END;
    CREATE TRIGGER bench_${index}_after AFTER UPDATE OF ${inputs.join(",")} ON characters WHEN ${changed} BEGIN ${insertion} END;`);
}

type Strategy = "current" | "combined" | "split" | "dual";
type QuerySpec = { label: string; search: string; scope?: "metadata" | "content"; scan?: boolean; candidateFirst?: boolean; sort?: "name" | "recent" | "relevance"; offset?: number; libraryScope?: string };
function buildPage(db: Database, strategy: Strategy, spec: QuerySpec) {
  const terms = spec.search.trim().split(/\s+/).map(t => `"${t.replaceAll('"', '""')}"`);
  const match = terms.join(" ");
  let from = "characters c", where = "c.user_id=? AND c.deleting=0";
  let params: any[] = ["bench"];
  let candidateParams = 0;
  if (spec.scan) {
    const fields = spec.scope === "metadata" ? metadata : [...metadata, ...direct, "alternate_greetings", "extensions"];
    where += ` AND (${fields.map(c => `c.${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
    params.push(...fields.map(() => `%${spec.search.replace(/[\\%_]/g, "\\$&")}%`));
  } else if (spec.candidateFirst) {
    assert.equal(strategy, "dual");
    from += " JOIN (SELECT rowid FROM characters_body_fts WHERE characters_body_fts MATCH ? LIMIT -1) hits ON hits.rowid=c.rowid";
    params = [match, ...params]; candidateParams = 1;
  } else if (strategy === "split" && spec.scope !== "metadata") {
    // Union metadata/body candidates for EACH term, then intersect terms by
    // joining. A union of whole-query results misses terms split across indexes.
    from += terms.map((_, i) => ` JOIN (SELECT rowid FROM characters_fts WHERE characters_fts MATCH ? UNION SELECT rowid FROM characters_body_fts WHERE characters_body_fts MATCH ?) hits${i} ON hits${i}.rowid=c.rowid`).join("");
    params = [...terms.flatMap(term => [term, term]), ...params];
    candidateParams = terms.length * 2;
  } else {
    const index = strategy === "dual" && spec.scope !== "metadata" ? "characters_body_fts" : "characters_fts";
    from += ` JOIN ${index} fts ON fts.rowid=c.rowid`;
    where += ` AND ${index} MATCH ?`;
    params.push(strategy === "combined" && spec.scope === "metadata" ? `{name creator tags}: (${match})` : match);
  }
  if (spec.libraryScope) { where += " AND c.library_scope=?"; params.push(spec.libraryScope); }
  const sort = spec.sort ?? "name";
  const order = sort === "recent" ? "MAX(c.updated_at,COALESCE(cs.last_chatted_at,c.updated_at)) DESC,c.updated_at DESC,c.id ASC" : sort === "relevance" ? "rank" : "c.name ASC,c.id ASC";
  const dataSql = `SELECT ${summaryColumns} FROM ${from} ${sort === "recent" ? recentJoin : ""} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`;
  const dataParams = [...params.slice(0, candidateParams), ...(sort === "recent" ? ["bench", "bench"] : []), ...params.slice(candidateParams), 81, spec.offset ?? 0];
  const data = db.query(dataSql), count = db.query(countSql);
  const run = () => {
    const rows = data.all(...dataParams) as any[];
    const hasMore = rows.length > 80;
    if (hasMore) rows.length = 80;
    const total = (spec.offset ?? 0) === 0 && !hasMore ? rows.length : (count.get(...params) as { count: number }).count;
    return { total, ids: rows.map(r => r.id), rows: rows.map(r => ({ ...r, tags: JSON.parse(r.tags), has_alternate_greetings: !!r.has_alternate_greetings })) };
  };
  return { run, dataSql, dataParams, finalize: () => { data.finalize(); count.finalize(); } };
}

function verify(db: Database, strategy: Strategy) {
  db.query("INSERT INTO characters(id,user_id,name,creator,description,personality,scenario,first_mes,mes_example,creator_notes,system_prompt,post_history_instructions,alternate_greetings,extensions) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("sentinel", "bench", "qzxname", "qzxauthor", "qzxdescription", "qzxpersonality", "qzxscenario", "qzxfirst", "qzxexample", "qzxnotes", "qzxsystem", "qzxhistory", '["qzxgreeting","魔法図書館"]', '{"alternate_fields":{"description":[{"label":"qzxlabel","content":"qzxvariant"}]}}');
  const expect = (search: string, found: boolean) => {
    const query = buildPage(db, strategy, { label: "check", search });
    const result = query.run(); query.finalize();
    assert.equal(result.ids.includes("sentinel"), found, `${strategy}: ${search}`);
  };
  for (const term of ["qzxname", "qzxauthor"]) expect(term, true);
  for (const term of ["qzxdescription", "qzxpersonality", "qzxscenario", "qzxfirst", "qzxexample", "qzxnotes", "qzxsystem", "qzxhistory", "qzxgreeting", "qzxvariant", "qzxlabel", "魔法図書館", "qzxname qzxfirst"]) expect(term, strategy !== "current");
  db.run("UPDATE characters SET first_mes='qzxchanged' WHERE id='sentinel'");
  expect("qzxfirst", false); expect("qzxchanged", strategy !== "current");
  db.run(`UPDATE characters SET alternate_greetings='["qzxnewgreeting"]',extensions='{"alternate_fields":{"scenario":[{"label":"qzxnewlabel","content":"qzxnewvariant"}]}}' WHERE id='sentinel'`);
  for (const term of ["qzxgreeting", "qzxvariant", "qzxlabel"]) expect(term, false);
  for (const term of ["qzxnewgreeting", "qzxnewvariant", "qzxnewlabel"]) expect(term, strategy !== "current");
  db.run("UPDATE characters SET folder='Changed' WHERE id='sentinel'"); expect("qzxname", true);
  db.run("DELETE FROM characters WHERE id='sentinel'"); expect("qzxname", false);
  for (const name of ["split", "dual"].includes(strategy) ? ["characters_fts", "characters_body_fts"] : ["characters_fts"]) {
    db.run(`INSERT INTO ${name}(${name},rank) VALUES('integrity-check',1)`);
  }
}

function indexBytes(db: Database) {
  return db.query("SELECT CASE WHEN name LIKE 'characters_body_fts_%' THEN 'body' ELSE 'metadata_or_combined' END AS kind,SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'characters_fts_%' OR name LIKE 'characters_body_fts_%' GROUP BY kind").all();
}

async function bench(directory: string, profile: string, requested?: string) {
  assert(["original", "enriched"].includes(profile));
  const source = new Database(join(directory, "corpus.sqlite"), { readonly: true });
  const count = (source.query("SELECT COUNT(*) AS count FROM characters").get() as { count: number }).count; source.close();
  const limit = requested ? Number(requested) : count;
  assert(Number.isInteger(limit) && limit > 0 && limit <= count);
  const label = `${profile}-${limit}`;
  const path = join(directory, `${label}.sqlite`), db = newLibrary(path);
  db.query("ATTACH DATABASE ? AS corpus").run(join(directory, "corpus.sqlite"));
  // Evenly sample the entire sorted corpus for smaller libraries.
  db.run(`INSERT INTO characters SELECT * FROM corpus.characters WHERE rowid IN
    (SELECT rowid FROM (SELECT rowid,row_number() OVER(ORDER BY id)-1 AS n FROM corpus.characters) WHERE CAST(n*${limit}.0/${count} AS INTEGER) != CAST((n-1)*${limit}.0/${count} AS INTEGER) OR n=0) LIMIT ${limit}`);
  db.run("DETACH DATABASE corpus");
  const actual = (db.query("SELECT COUNT(*) AS count FROM characters").get() as { count: number }).count;
  assert.equal(actual, limit);
  if (profile === "enriched") { log({ phase: "enrich", label }); enrich(db); }
  const ids = (db.query("SELECT id FROM characters ORDER BY id").all() as { id: string }[]).map(r => r.id);
  // Three one-to-one chats per card plus one group per ten cards. Mock recent
  // activity keeps actual service sort joins in the timed page queries.
  const chat = db.query("INSERT INTO chats(id,user_id,character_id,name,metadata,updated_at,created_at) VALUES(?,'bench',?,'Benchmark',?,?,?)");
  db.transaction(() => ids.forEach((id, i) => {
    for (let j = 0; j < 3; j++) chat.run(`chat-${i}-${j}`, id, "{}", 1_700_000_000 + i * 60 + j, 1_700_000_000);
    if (i % 10 === 0) chat.run(`group-${i}`, null, JSON.stringify({ group: true, character_ids: [id, ids[(i + 1) % ids.length], ids[(i + 2) % ids.length]] }), 1_700_000_000 + i * 60, 1_700_000_000);
  }))();
  const result: any = {
    label, generatedAt: new Date().toISOString(), bun: Bun.version,
    sqlite: db.query("SELECT sqlite_version() AS version").get(),
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, ramGiB: totalmem() / 2 ** 30 },
    pragmas: { journal: "WAL", synchronous: "NORMAL", cacheMiB: 64, mmap: 0, walAutocheckpoint: 500 },
    corpus: corpusStats(db), chats: db.query("SELECT COUNT(*) AS count FROM chats").get(), strategies: [],
  };
  const queries: QuerySpec[] = [
    ...["school", "friend", "magic", "hello", "the", "qzxabsentbenchmark"].map(search => ({ label: `content:${search}`, search })),
    { label: "content:multi", search: "school friend" },
    { label: "content:recent", search: "friend", sort: "recent" },
    { label: "content:deep-page", search: "friend", offset: 800 },
    { label: "content:scope", search: "friend", libraryScope: "mine" },
    { label: "metadata:school", search: "school", scope: "metadata" },
    { label: "metadata:author", search: "Benchmark author 101", scope: "metadata" },
    { label: "metadata:recent", search: "school", scope: "metadata", sort: "recent" },
    { label: "short:metadata", search: "xy", scope: "metadata", scan: true },
    { label: "short:all", search: "xy", scan: true },
    { label: "short:cjk-all", search: "魔法", scan: true },
  ];
  const fingerprints = new Map<string, string>();
  for (const strategy of ["current", "combined", "split", "dual"] as Strategy[]) {
    removeSearch(db); createView(db);
    log({ phase: "index-start", label, strategy });
    const built = timed(() => {
      if (strategy === "combined") addIndex(db, "characters_fts", allColumns, "character_search_source");
      else {
        addIndex(db, "characters_fts", metadata, "characters");
        if (strategy === "split") addIndex(db, "characters_body_fts", body, "character_search_source");
        if (strategy === "dual") addIndex(db, "characters_body_fts", allColumns, "character_search_source");
      }
    });
    const checkpoint = timed(() => db.run("PRAGMA wal_checkpoint(TRUNCATE)"));
    const entry: any = { strategy, buildMs: built.ms, checkpointMs: checkpoint.ms, indexBytes: indexBytes(db), databaseBytes: statSync(path).size, queries: [] };
    log({ phase: "indexed", label, ...entry });
    verify(db, strategy); entry.integrityChecks = "passed";
    const strategyQueries: QuerySpec[] = [...queries];
    if (strategy !== "split") strategyQueries.push({ label: "content:relevance", search: "friend", sort: "relevance" });
    if (strategy === "dual") strategyQueries.push(
      { label: "content:friend-candidates", search: "friend", candidateFirst: true },
      { label: "content:school-candidates", search: "school", candidateFirst: true },
      { label: "content:recent-candidates", search: "friend", sort: "recent", candidateFirst: true },
      { label: "content:multi-candidates", search: "school friend", candidateFirst: true },
    );
    const prepared = strategyQueries.map(spec => ({ spec, ...buildPage(db, strategy, spec), samples: [] as number[], firstMs: 0, total: 0 }));
    // Releasing SQLite's cache is not an OS cold-cache test. Report this first
    // read separately from interleaved warm samples; never claim cold storage.
    for (const q of prepared) {
      db.run("PRAGMA shrink_memory");
      const first = timed(q.run); q.firstMs = first.ms; q.total = first.value.total;
      const fingerprint = JSON.stringify({ total: first.value.total, ids: first.value.ids });
      const key = q.spec.label.replace(/-candidates$/, "");
      if (strategy === "combined") fingerprints.set(key, fingerprint);
      if (strategy === "split" || strategy === "dual") assert.equal(fingerprint, fingerprints.get(key), `Combined/${strategy} mismatch: ${key}`);
      q.run();
    }
    for (let round = 0; round < 25; round++) {
      // Rotate order so scans/recent joins do not always affect the same query.
      for (let j = 0; j < prepared.length; j++) {
        const q = prepared[(j + round) % prepared.length];
        q.samples.push(timed(q.run).ms);
      }
      if (round % 5 === 0) { log({ phase: "query-round", label, strategy, round }); await Bun.sleep(0); }
    }
    entry.queries = prepared.map(q => ({ ...q.spec, matches: q.total, sqliteCacheReleasedFirstMs: q.firstMs, warmMs: stats(q.samples), plan: db.query("EXPLAIN QUERY PLAN " + q.dataSql).all(...q.dataParams) }));
    prepared.forEach(q => q.finalize());
    const editRows = db.query("SELECT id,first_mes,updated_at,folder FROM characters ORDER BY length(first_mes) DESC LIMIT 100").all() as { id: string; first_mes: string; updated_at: number; folder: string }[];
    entry.edits = [];
    for (const [kind, sql, bind] of [
      ["greeting", "UPDATE characters SET first_mes=?,updated_at=updated_at+1 WHERE id=?", (row: typeof editRows[number], i: number) => [row.first_mes + `\nBenchmark edit ${i}`, row.id]],
      ["folder", "UPDATE characters SET folder=?,updated_at=updated_at+1 WHERE id=?", (row: typeof editRows[number], i: number) => [`Changed ${i}`, row.id]],
      ["noop-greeting", "UPDATE characters SET first_mes=first_mes WHERE id=?", (row: typeof editRows[number]) => [row.id]],
    ] as const) {
      const stmt = db.query(sql), samples = editRows.map((row, i) => timed(() => stmt.run(...bind(row, i))).ms);
      entry.edits.push({ kind, ms: stats(samples) });
      stmt.finalize();
    }
    // A batched text import with all indexes active; transaction/commit included.
    const importSql = db.query("INSERT INTO characters(id,user_id,name,creator,tags,description,personality,scenario,first_mes,mes_example,creator_notes,system_prompt,post_history_instructions,alternate_greetings,extensions,created_at,updated_at) SELECT ?,user_id,name,creator,tags,description,personality,scenario,first_mes,mes_example,creator_notes,system_prompt,post_history_instructions,alternate_greetings,extensions,created_at,updated_at FROM characters WHERE id=?");
    entry.importBatch100Ms = timed(() => db.transaction(() => editRows.forEach((row, i) => importSql.run(`import-${i}`, row.id)))()).ms;
    importSql.finalize();
    db.run("DELETE FROM characters WHERE id LIKE 'import-%'");
    // Restore edits, giving every strategy exactly the same searchable corpus.
    const restore = db.query("UPDATE characters SET first_mes=?,updated_at=?,folder=? WHERE id=?");
    db.transaction(() => editRows.forEach(row => restore.run(row.first_mes, row.updated_at, row.folder, row.id)))();
    restore.finalize();
    db.clearQueryCache();
    assert(!db.inTransaction);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    entry.maxRssMiB = rounded(process.resourceUsage().maxRSS / 1024);
    result.strategies.push(entry);
    writeFileSync(join(directory, `${label}-results.json`), JSON.stringify(result, null, 2) + "\n");
    log({ phase: "strategy-complete", label, strategy, buildMs: entry.buildMs, indexBytes: entry.indexBytes, edits: entry.edits, importBatch100Ms: entry.importBatch100Ms });
    await Bun.sleep(0);
  }
  db.close(); log({ phase: "complete", results: join(directory, `${label}-results.json`) });
}

if (command === "selftest") {
  const db = newLibrary(":memory:");
  for (const strategy of ["current", "combined", "split", "dual"] as Strategy[]) {
    db.clearQueryCache(); removeSearch(db); createView(db);
    if (strategy === "combined") addIndex(db, "characters_fts", allColumns, "character_search_source");
    else {
      addIndex(db, "characters_fts", metadata, "characters");
      if (strategy === "split") addIndex(db, "characters_body_fts", body, "character_search_source");
      if (strategy === "dual") addIndex(db, "characters_body_fts", allColumns, "character_search_source");
    }
    verify(db, strategy); log({ strategy, checks: "passed" });
  }
  db.close();
}
else if (command === "prepare" && arg1 && arg2) await prepare(resolve(arg1), resolve(arg2));
else if (command === "bench" && arg1 && arg2) await bench(resolve(arg1), arg2, arg3);
else throw new Error("Usage: prepare <cards-directory> <new-output-directory> | bench <output-directory> <original|enriched> [limit]");
