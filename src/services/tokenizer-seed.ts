import { getDb } from "../db/connection";

// Kimi K2 / K2.5 tiktoken pre-tokenization regex. Ported from
// `tokenization_kimi.py` in moonshotai/Kimi-K2.5. The original uses Java-style
// set intersection `[...&&[^\p{Han}]]` to exclude Han from Latin letter groups;
// JS regex u flag doesn't support `&&`, so we swap it for a `(?!\p{Script=Han})`
// negative lookahead before each Latin char. Also `\p{Han}` is non-standard in
// JS — use `\p{Script=Han}`.
const KIMI_PAT_STR = [
  "[\\p{Script=Han}]+",
  "[^\\r\\n\\p{L}\\p{N}]?(?:(?!\\p{Script=Han})[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}])*(?:(?!\\p{Script=Han})[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}])+(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
  "[^\\r\\n\\p{L}\\p{N}]?(?:(?!\\p{Script=Han})[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}])+(?:(?!\\p{Script=Han})[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}])*(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
  "\\p{N}{1,3}",
  " ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*",
  "\\s*[\\r\\n]+",
  "\\s+(?!\\S)",
  "\\s+",
].join("|");

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
    // NOTE: @lenml/tokenizer-claude@3.7.2 (Sep 2025) predates Claude Opus 4.7
    // (Apr 2026), which shipped a new tokenizer that produces ~1.0–1.35x more
    // tokens for the same input. Counts for Opus 4.7+ are a lower bound until
    // an updated package ships.
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
    id: "kimi-k2",
    name: "Moonshot Kimi K2 / K2.5",
    type: "tiktoken",
    config: JSON.stringify({
      url: "https://huggingface.co/moonshotai/Kimi-K2.5/resolve/main/tiktoken.model",
      configUrl: "https://huggingface.co/moonshotai/Kimi-K2.5/resolve/main/tokenizer_config.json",
      pat_str: KIMI_PAT_STR,
    }),
  },
  {
    id: "glm-4",
    name: "Z.ai GLM-4 (4.5/4.6/4.7)",
    type: "huggingface",
    config: JSON.stringify({
      url: "https://huggingface.co/zai-org/GLM-4.7/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/zai-org/GLM-4.7/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "glm-5",
    name: "Z.ai GLM-5 (5/5.1)",
    type: "huggingface",
    config: JSON.stringify({
      url: "https://huggingface.co/zai-org/GLM-5.1/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/zai-org/GLM-5.1/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "grok",
    name: "xAI Grok (2 / 3 / 4.x)",
    type: "huggingface",
    // Grok-2 weights were open-sourced; 3 / 4 / 4.1 / 4.20 are closed. Using
    // the Grok-2 tokenizer as best-effort for the 3/4 line — xAI's tokenizer
    // scheme likely evolved incrementally (like OpenAI cl100k→o200k), so the
    // drift is small enough for context-budget counting. The Hugging-Face-
    // compatible conversion lives at alvarobartt/grok-2-tokenizer; xai-org/grok-2
    // itself only ships a custom `tokenizer.tok.json` our loader can't read.
    config: JSON.stringify({
      url: "https://huggingface.co/alvarobartt/grok-2-tokenizer/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/alvarobartt/grok-2-tokenizer/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "mistral",
    name: "Mistral (Large 3 / Small 4 / Magistral / Pixtral / Codestral)",
    type: "huggingface",
    // Mistral-Large-3 ships the current-generation Tekken tokenizer shared
    // across the 2025–2026 Mistral family (mistral-*, mixtral, magistral,
    // pixtral, devstral, voxtral, ministral, codestral). Older v0.1/v0.2/v0.3
    // 7B/Mixtral lines used a smaller 32k SentencePiece vocab — counts for
    // those will drift high but remain closer than the chars/4 fallback.
    config: JSON.stringify({
      url: "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "qwen-3",
    name: "Alibaba Qwen (1 / 2 / 2.5 / 3)",
    type: "huggingface",
    config: JSON.stringify({
      url: "https://huggingface.co/Qwen/Qwen3-8B/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/Qwen/Qwen3-8B/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "qwen-3-5",
    name: "Alibaba Qwen 3.5",
    type: "huggingface",
    // Qwen3.5 shifted the tokenizer vs Qwen3 — emoji / rare-char handling
    // differs measurably — so it gets its own entry instead of falling back
    // to qwen-3.
    config: JSON.stringify({
      url: "https://huggingface.co/Qwen/Qwen3.5-27B/resolve/main/tokenizer.json",
      configUrl: "https://huggingface.co/Qwen/Qwen3.5-27B/resolve/main/tokenizer_config.json",
    }),
  },
  {
    id: "approximate-4",
    name: "Rough Estimate (chars/4)",
    type: "approximate",
    config: JSON.stringify({ charsPerToken: 4 }),
  },
];

// Patterns match both bare model ids (`gpt-4o`) and namespaced ids served by
// aggregators / managed runtimes:
//   `/` — OpenRouter, e.g. `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`
//   `:` — Vertex-style publisher prefixes, e.g. `publishers/anthropic:claude-3-5-sonnet`
//   `.` — AWS Bedrock, e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`
const BUILT_IN_PATTERNS = [
  { id: "pat-openai-o200k", tokenizer_id: "openai-o200k", pattern: "(?:^|[/:.])(?:gpt-4o|gpt-[5-9]|o[1-9]|chatgpt-)", priority: 100 },
  { id: "pat-openai-cl100k", tokenizer_id: "openai-cl100k", pattern: "(?:^|[/:.])gpt-(?:4(?!o)|3\\.5)", priority: 90 },
  { id: "pat-claude", tokenizer_id: "claude", pattern: "(?:^|[/:.])claude-", priority: 80 },
  { id: "pat-gemini", tokenizer_id: "gemma-3", pattern: "(?:^|[/:.])(?:gemini-|gemma-)", priority: 80 },
  // Covers bare ids (`kimi-k2`, `kimi-k2.5`), Moonshot native (`kimi-latest`),
  // and OpenRouter-prefixed (`moonshotai/kimi-k2.5`).
  { id: "pat-kimi", tokenizer_id: "kimi-k2", pattern: "(?:^|[/:.])kimi-", priority: 80 },
  // GLM-5 first so `glm-5.1` doesn't get captured by the looser glm-4 pattern
  // if priorities ever collapse. Covers `z-ai/glm-5-turbo`, `glm-5.1`, etc.
  { id: "pat-glm-5", tokenizer_id: "glm-5", pattern: "(?:^|[/:.])glm-5", priority: 85 },
  { id: "pat-glm-4", tokenizer_id: "glm-4", pattern: "(?:^|[/:.])glm-4", priority: 80 },
  // Covers `grok-2`, `grok-3`, `grok-4`, `grok-4.1`, `grok-4.20-beta`, plus
  // OpenRouter's `x-ai/grok-4.20-beta` and xAI-native `grok-4-0709` style ids.
  { id: "pat-grok", tokenizer_id: "grok", pattern: "(?:^|[/:.])grok-", priority: 80 },
  // Mistral family — explicit roster so we don't accidentally eat unrelated
  // names. Covers `mistral-*`, `mixtral-*`, `ministral-*`, `codestral-*`,
  // `magistral-*`, `pixtral-*`, `devstral-*`, `voxtral-*`, and the
  // `open-mistral-*` / `open-mixtral-*` legacy family.
  { id: "pat-mistral", tokenizer_id: "mistral", pattern: "(?:^|[/:.])(?:mistral-|mixtral-|ministral-|codestral-|magistral-|pixtral-|devstral-|voxtral-|open-mi[sx]tral-)", priority: 80 },
  // Qwen 3.5 first (same priority-stacking trick as glm-5 over glm-4).
  // `qwen-?3[-.]5` catches `qwen3.5-*`, `qwen-3.5-*`, `qwen3-5-*`, `qwen-3-5-*`.
  { id: "pat-qwen-3-5", tokenizer_id: "qwen-3-5", pattern: "(?:^|[/:.])qwen-?3[-.]5", priority: 85 },
  { id: "pat-qwen-3", tokenizer_id: "qwen-3", pattern: "(?:^|[/:.])qwen", priority: 80 },
  { id: "pat-fallback", tokenizer_id: "approximate-4", pattern: ".*", priority: -1 },
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
