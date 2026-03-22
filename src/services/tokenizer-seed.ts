import { getDb } from "../db/connection";

const BUILT_IN_CONFIGS = [
  {
    id: "openai-o200k",
    name: "OpenAI o200k_base",
    type: "openai",
    config: JSON.stringify({ encoding: "o200k_base" }),
  },
  {
    id: "openai-cl100k",
    name: "OpenAI cl100k_base",
    type: "openai",
    config: JSON.stringify({ encoding: "cl100k_base" }),
  },
  {
    id: "claude",
    name: "Claude",
    type: "huggingface",
    config: JSON.stringify({ package: "@lenml/tokenizer-claude" }),
  },
  {
    id: "gemma-3",
    name: "Gemini / Gemma 3",
    type: "huggingface",
    config: JSON.stringify({
      url: "https://huggingface.co/unsloth/gemma-3-4b-it/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/unsloth/gemma-3-4b-it/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "approximate-4",
    name: "Rough Estimate (chars/4)",
    type: "approximate",
    config: JSON.stringify({ charsPerToken: 4 }),
  },
];

const BUILT_IN_PATTERNS = [
  { id: "pat-openai-o200k", tokenizer_id: "openai-o200k", pattern: "^(gpt-4o|o[1-9])", priority: 100 },
  { id: "pat-openai-cl100k", tokenizer_id: "openai-cl100k", pattern: "^(gpt-4(?!o)|gpt-3\\.5)", priority: 90 },
  { id: "pat-claude", tokenizer_id: "claude", pattern: "^claude-", priority: 80 },
  { id: "pat-gemini", tokenizer_id: "gemma-3", pattern: "^(gemini-|gemma-)", priority: 80 },
  { id: "pat-fallback", tokenizer_id: "approximate-4", pattern: ".*", priority: 0 },
];

export function seedTokenizers(): void {
  const db = getDb();

  const upsertConfig = db.prepare(
    `INSERT INTO tokenizer_configs (id, name, type, config, is_built_in, updated_at)
     VALUES (?, ?, ?, ?, 1, unixepoch())
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, config=excluded.config, is_built_in=1, updated_at=unixepoch()`
  );

  const upsertPattern = db.prepare(
    `INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern, priority, is_built_in, updated_at)
     VALUES (?, ?, ?, ?, 1, unixepoch())
     ON CONFLICT(id) DO UPDATE SET tokenizer_id=excluded.tokenizer_id, pattern=excluded.pattern, priority=excluded.priority, is_built_in=1, updated_at=unixepoch()`
  );

  db.transaction(() => {
    for (const c of BUILT_IN_CONFIGS) {
      upsertConfig.run(c.id, c.name, c.type, c.config);
    }
    for (const p of BUILT_IN_PATTERNS) {
      upsertPattern.run(p.id, p.tokenizer_id, p.pattern, p.priority);
    }
  })();

  console.log("[Startup] Built-in tokenizer configs + model patterns seeded.");
}
