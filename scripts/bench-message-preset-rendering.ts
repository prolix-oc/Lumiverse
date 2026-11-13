/** Synthetic, in-memory benchmark; never reads the application's database or user presets. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { getActiveScripts, getActiveScriptsForPreset } from "../src/services/regex-scripts.service";
import { applyDisplayRegex, resetDisplayRegexCache } from "../src/services/display-regex.service";
import { createChat, createMessage } from "../src/services/chats.service";
import { createPreset } from "../src/services/presets.service";
import { shutdownRegexSandbox } from "../src/utils/regex-sandbox";

const users = Number(Bun.argv[2] ?? 10_000);
const iterations = Number(Bun.argv[3] ?? 300);
if (!Number.isInteger(users) || users < 1 || users > 100_000
  || !Number.isInteger(iterations) || iterations < 10 || iterations > 10_000) {
  throw new Error("Usage: bun scripts/bench-message-preset-rendering.ts [users:1..100000] [iterations:10..10000]");
}

function summary(values: number[]) {
  values.sort((a, b) => a - b);
  return { medianMs: +values[Math.floor(values.length / 2)].toFixed(4), p95Ms: +values[Math.floor(values.length * .95)].toFixed(4) };
}

initDatabase(":memory:");
const db = getDb();
try {
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../src/db/baseline.sql")).text());
  const source = createPreset("user-0", { name: "Source", provider: "loom" });
  const insert = db.query(`INSERT INTO regex_scripts
    (id,user_id,name,find_regex,replace_string,flags,target,preset_id,sort_order)
    VALUES (?,?,?,?,?,'g','["display"]',?,?)`);
  db.transaction(() => {
    for (let u = 0; u < users; u++) for (let p = 0; p < 3; p++) for (let r = 0; r < 10; r++) {
      const preset = u === 0 && p === 0 ? source.id : `preset-${u}-${p}`;
      insert.run(`rule-${u}-${p}-${r}`, `user-${u}`, `Rule ${r}`, `\\[p${p}-${r}:(.*?)\\]`, '<span>$1</span>', preset, r);
    }
  })();
  const timings = { selected: [] as number[], all: [] as number[], single: [] as number[] };
  for (let i = -20; i < iterations; i++) {
    const u = Math.max(i, 0) % users;
    const user = `user-${u}`;
    const presetId = u === 0 ? source.id : `preset-${u}-0`;
    for (const mode of i % 2 === 0 ? ['selected', 'all'] as const : ['all', 'selected'] as const) {
      const start = performance.now();
      const rules = mode === 'selected' ? getActiveScriptsForPreset(user, { presetId, target: 'display' })
        : getActiveScripts(user, { target: 'display' });
      if (i >= 0) timings[mode].push(performance.now() - start);
      assert.equal(rules.length, mode === 'selected' ? 10 : 30);
    }
  }
  db.run("UPDATE regex_scripts SET disabled=1 WHERE preset_id LIKE '%-1' OR preset_id LIKE '%-2'");
  for (let i = -20; i < iterations; i++) {
    const start = performance.now();
    const rules = getActiveScripts(`user-${Math.max(i, 0) % users}`, { target: 'display' });
    if (i >= 0) timings.single.push(performance.now() - start);
    assert.equal(rules.length, 10);
  }

  const chat = createChat("user-0", {});
  const message = createMessage(chat.id, { name: "Assistant", is_user: false, content: "fixture" }, "user-0");
  const scripts = getActiveScriptsForPreset("user-0", { presetId: source.id, target: "display" });
  const body = ('[p0-0:example] ' + 'prose '.repeat(100)).repeat(20);
  const renderTimings = { single: [] as number[], selected: [] as number[] };
  const input = { userId: "user-0", content: body, scripts,
    context: { chat_id: chat.id, message_id: message.id, is_user: false, depth: 0 }, preprocessed: true };
  const presetContext = { preset_id: source.id, variables: { local: { mode: "a" }, prompt_defaults: { mode: "a" } } };
  for (let i = -10; i < iterations; i++) {
    for (const mode of i % 2 === 0 ? ['selected', 'single'] as const : ['single', 'selected'] as const) {
      resetDisplayRegexCache();
      const start = performance.now();
      const result = await applyDisplayRegex({ ...input, ...(mode === "selected" ? { presetContext } : {}) });
      if (i >= 0) renderTimings[mode].push(performance.now() - start);
      assert(result.result.startsWith('<span>example</span>'));
    }
  }
  console.log(JSON.stringify({ users, rows: users * 30, iterations, inputCharacters: body.length,
    selection: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summary(values)])),
    uncachedBackendRender: Object.fromEntries(Object.entries(renderTimings).map(([key, values]) => [key, summary(values)])),
    scope: "Sequential indexed selection and backend fallback, not concurrent users or browser frame time",
  }, null, 2));
} finally {
  shutdownRegexSandbox();
  closeDatabase();
}
// Imported application services may retain background maintenance timers.
process.exit(0);
