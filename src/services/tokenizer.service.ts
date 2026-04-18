import { getDb } from "../db/connection";
import type { TokenizerConfig, TokenizerModelPattern, TokenCountResult, TokenCountBreakdownEntry } from "../types/tokenizer";
import { getTextContent, type AssemblyBreakdownEntry, type LlmMessage } from "../llm/types";
import { validateHost, SSRFError } from "../utils/safe-fetch";

/**
 * Validate a tokenizer resource URL before fetching. Owner-supplied, but still
 * should not reach private/internal hosts.
 */
async function validateTokenizerUrl(url: string, label: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFError(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SSRFError(`${label} must use http or https, got: ${parsed.protocol}`);
  }
  await validateHost(parsed.hostname);
}

/** A loaded tokenizer instance with a count(text) method. */
interface TokenizerInstance {
  count: (text: string) => number;
}

// ---- Caches ----
const instanceCache = new Map<string, TokenizerInstance>();
let patternCache: { patterns: { regex: RegExp; tokenizerId: string }[] } | null = null;

// ---- Helpers ----

function parseConfig(row: any): TokenizerConfig {
  return {
    ...row,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    is_built_in: !!row.is_built_in,
  };
}

function getAllConfigs(): TokenizerConfig[] {
  const db = getDb();
  const rows = db.query("SELECT * FROM tokenizer_configs ORDER BY name").all();
  return rows.map(parseConfig);
}

function getConfig(id: string): TokenizerConfig | null {
  const db = getDb();
  const row = db.query("SELECT * FROM tokenizer_configs WHERE id = ?").get(id) as any;
  return row ? parseConfig(row) : null;
}

function getAllPatterns(): TokenizerModelPattern[] {
  const db = getDb();
  // Sort: highest priority first. Within the same priority tier, custom (non-built-in)
  // patterns come before built-in ones so user patterns always beat the .* catchall.
  const rows = db.query("SELECT * FROM tokenizer_model_patterns ORDER BY priority DESC, is_built_in ASC, created_at DESC").all();
  return rows.map((r: any) => ({ ...r, is_built_in: !!r.is_built_in }));
}

// ---- Pattern matching ----

function loadPatterns(): { regex: RegExp; tokenizerId: string }[] {
  if (patternCache) {
    return patternCache.patterns;
  }
  const rows = getAllPatterns();
  const compiled: { regex: RegExp; tokenizerId: string }[] = [];
  for (const row of rows) {
    try {
      compiled.push({ regex: new RegExp(row.pattern, "i"), tokenizerId: row.tokenizer_id });
    } catch {
      // skip invalid regex
    }
  }
  patternCache = { patterns: compiled };
  return compiled;
}

function getTokenizerIdForModel(modelId: string): string | null {
  const patterns = loadPatterns();
  for (const { regex, tokenizerId } of patterns) {
    if (regex.test(modelId)) return tokenizerId;
  }
  return null;
}

// ---- Loaders ----

async function loadTokenizer(config: TokenizerConfig): Promise<TokenizerInstance> {
  switch (config.type) {
    case "openai":
      return loadOpenAI(config);
    case "huggingface":
      return loadHuggingFace(config);
    case "tiktoken":
      return loadTiktoken(config);
    case "approximate":
      return loadApproximate(config);
    default:
      throw new Error(`Unknown tokenizer type: ${config.type}`);
  }
}

async function loadOpenAI(config: TokenizerConfig): Promise<TokenizerInstance> {
  const encoding = config.config.encoding || "o200k_base";
  let mod: any;
  switch (encoding) {
    case "cl100k_base":
      mod = await import("gpt-tokenizer/encoding/cl100k_base");
      break;
    case "o200k_base":
    default:
      mod = await import("gpt-tokenizer/encoding/o200k_base");
      break;
  }
  const encode = mod.encode || mod.default?.encode;
  if (!encode) throw new Error(`Could not find encode function for ${encoding}`);
  return { count: (text: string) => encode(text).length };
}

async function loadHuggingFace(config: TokenizerConfig): Promise<TokenizerInstance> {
  const cfg = config.config;

  // Try package import first (e.g. @lenml/tokenizer-claude)
  if (cfg.package) {
    try {
      const mod = await import(cfg.package);

      // @lenml/tokenizer-* v3.x packages export fromPreTrained(params?) which builds
      // a tokenizer from embedded model data (tokenizerJSON + tokenizerConfig baked in)
      if (typeof mod.fromPreTrained === "function") {
        const tokenizer = mod.fromPreTrained();
        if (tokenizer?.encode) {
          return { count: (text: string) => tokenizer.encode(text).length };
        }
      }

      // Legacy: some packages export a ready-to-use tokenizer instance
      const tokenizer = mod.tokenizer || mod.default?.tokenizer || mod.default;
      if (tokenizer?.encode) {
        return { count: (text: string) => tokenizer.encode(text).length };
      }
    } catch {
      // fall through to URL loading
    }
  }

  // URL-based loading via @lenml/tokenizers
  if (cfg.url) {
    const { TokenizerLoader } = await import("@lenml/tokenizers");

    // v3.x requires both tokenizerJSON and tokenizerConfig URLs.
    // Auto-derive config URL from the tokenizer URL if not explicitly provided.
    const configUrl = cfg.configUrl || cfg.url.replace(/tokenizer\.json$/, "tokenizer_config.json");

    // If the user's URL doesn't end with tokenizer.json (e.g. a direct download link),
    // try fetching the JSON data manually and use fromPreTrained() instead of fromPreTrainedUrls()
    if (configUrl === cfg.url) {
      await validateTokenizerUrl(cfg.url, "tokenizer url");
      const resp = await fetch(cfg.url);
      if (!resp.ok) throw new Error(`Failed to fetch tokenizer.json from ${cfg.url}: ${resp.status}`);
      const tokenizerJSON = await resp.json();
      const tokenizer = TokenizerLoader.fromPreTrained({
        tokenizerJSON,
        tokenizerConfig: { tokenizer_class: "PreTrainedTokenizer" },
      });
      return { count: (text: string) => tokenizer.encode(text).length };
    }

    // fromPreTrainedUrls() fetches both URLs internally — validate both hosts up front
    await validateTokenizerUrl(cfg.url, "tokenizer url");
    await validateTokenizerUrl(configUrl, "tokenizer config url");
    const tokenizer = await TokenizerLoader.fromPreTrainedUrls({
      tokenizerJSON: cfg.url,
      tokenizerConfig: configUrl,
    });
    return { count: (text: string) => tokenizer.encode(text).length };
  }

  throw new Error("HuggingFace tokenizer requires either 'package' or 'url' in config");
}

async function loadTiktoken(config: TokenizerConfig): Promise<TokenizerInstance> {
  const { Tiktoken } = await import("js-tiktoken/lite");
  const cfg = config.config;
  if (!cfg.url) throw new Error("Tiktoken requires 'url' in config pointing to .model file");

  await validateTokenizerUrl(cfg.url, "tiktoken model url");
  const resp = await fetch(cfg.url);
  if (!resp.ok) throw new Error(`Failed to fetch tiktoken model from ${cfg.url}`);
  const bpeData = await resp.text();

  // Parse special tokens from tokenizer_config.json if provided
  let specialTokens: Record<string, number> = {};
  if (cfg.configUrl) {
    try {
      await validateTokenizerUrl(cfg.configUrl, "tiktoken config url");
      const configResp = await fetch(cfg.configUrl);
      if (configResp.ok) {
        const configData = await configResp.json();
        if (configData.added_tokens_decoder) {
          for (const [id, tok] of Object.entries(configData.added_tokens_decoder)) {
            if ((tok as any).special) {
              specialTokens[(tok as any).content] = parseInt(id, 10);
            }
          }
        }
      }
    } catch {
      // ignore config fetch errors
    }
  }

  // Default regex pattern for cl100k_base / o200k_base style tokenizers
  const patStr = cfg.pat_str ||
    "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

  const enc = new Tiktoken({ pat_str: patStr, special_tokens: specialTokens, bpe_ranks: bpeData });
  return { count: (text: string) => enc.encode(text).length };
}

function loadApproximate(config: TokenizerConfig): TokenizerInstance {
  const charsPerToken = config.config.charsPerToken || 4;
  return { count: (text: string) => Math.ceil(text.length / charsPerToken) };
}

// ---- Instance management ----

async function getInstance(tokenizerId: string): Promise<TokenizerInstance> {
  const cached = instanceCache.get(tokenizerId);
  if (cached) return cached;

  const config = getConfig(tokenizerId);
  if (!config) throw new Error(`Tokenizer not found: ${tokenizerId}`);

  const instance = await loadTokenizer(config);
  instanceCache.set(tokenizerId, instance);
  return instance;
}

// ---- Public API ----

export async function countForModel(modelId: string, text: string): Promise<number | null> {
  const tokenizerId = getTokenizerIdForModel(modelId);
  if (!tokenizerId) return null;
  try {
    return await countWithTokenizer(tokenizerId, text);
  } catch {
    return null;
  }
}

export async function countWithTokenizer(tokenizerId: string, text: string): Promise<number> {
  const instance = await getInstance(tokenizerId);
  return instance.count(text);
}

export async function countBreakdown(
  modelId: string,
  breakdown: AssemblyBreakdownEntry[],
  chatHistoryMessages?: LlmMessage[]
): Promise<TokenCountResult> {
  const tokenizerId = getTokenizerIdForModel(modelId);
  let tokenizerName: string | null = null;

  // Resolve instance and name once, then count synchronously for each entry
  let instance: TokenizerInstance | null = null;
  if (tokenizerId) {
    const config = getConfig(tokenizerId);
    tokenizerName = config?.name || null;
    try {
      instance = await getInstance(tokenizerId);
    } catch {
      // fall through to approximate counting
    }
  }

  const countText = (text: string): number => {
    if (!text) return 0;
    if (instance) {
      try { return instance.count(text); } catch { /* fall through */ }
    }
    return Math.ceil(text.length / 4);
  };

  const entries: TokenCountBreakdownEntry[] = [];
  let totalTokens = 0;

  for (const entry of breakdown) {
    let tokens = 0;

    if (entry.preCountedTokens != null) {
      tokens = entry.preCountedTokens;
    } else if (entry.type === "chat_history" && chatHistoryMessages && chatHistoryMessages.length > 0) {
      // Concatenate all messages into a single string and tokenize once.
      // Per-message encode() calls have significant per-call overhead (regex
      // preprocessing, BPE merges, array alloc) that compounds on slower runtimes.
      const bulk = chatHistoryMessages
        .map(msg => `${msg.role}\n${getTextContent(msg)}`)
        .join("\n");
      tokens = countText(bulk);
    } else {
      tokens = countText(entry.content || "");
    }

    if (!entry.excludeFromTotal) {
      totalTokens += tokens;
    }
    entries.push({
      name: entry.name,
      type: entry.type,
      tokens,
      role: entry.role,
      blockId: entry.blockId,
    });
  }

  return {
    total_tokens: totalTokens,
    breakdown: entries,
    tokenizer_id: tokenizerId,
    tokenizer_name: tokenizerName,
  };
}

/**
 * Resolve a synchronous token counter for a model. Loads the tokenizer
 * instance (cached after first use), returns a `count(text)` that runs
 * in-process with zero per-call await overhead, and a display `name`.
 *
 * When no tokenizer can be resolved (unknown model, fetch failure, etc.),
 * falls back to the `char/4` heuristic and reports the name as `"approximate"`.
 *
 * Intended for hot loops (e.g. context-budget clipping) that tokenize every
 * message in the assembled prompt and need to avoid async overhead per call.
 */
export async function resolveCounter(modelId: string): Promise<{ count: (text: string) => number; name: string }> {
  const tokenizerId = modelId ? getTokenizerIdForModel(modelId) : null;
  if (tokenizerId) {
    const config = getConfig(tokenizerId);
    try {
      const instance = await getInstance(tokenizerId);
      const name = config?.name || tokenizerId;
      return {
        count: (text: string) => {
          if (!text) return 0;
          try { return instance.count(text); } catch { return Math.ceil(text.length / 4); }
        },
        name,
      };
    } catch {
      // fall through to approximate
    }
  }
  return {
    count: (text: string) => (text ? Math.ceil(text.length / 4) : 0),
    name: "approximate",
  };
}

export { getTokenizerIdForModel, getAllConfigs, getConfig, getAllPatterns };

export function invalidate(tokenizerId: string): void {
  instanceCache.delete(tokenizerId);
}

export function invalidatePatterns(): void {
  patternCache = null;
}

/**
 * Pre-warm tokenizer instances for all models referenced by existing connection
 * profiles. Resolves each unique model to its tokenizer ID and eagerly loads the
 * instance so the first dry-run / generation doesn't pay the cold-start import
 * cost (2+ MB module parse for gpt-tokenizer / @lenml/tokenizer-claude).
 *
 * Intended to be called fire-and-forget at startup — failures are non-fatal.
 */
export async function prewarm(): Promise<void> {
  const db = getDb();
  const rows = db.query("SELECT DISTINCT model FROM connection_profiles WHERE model IS NOT NULL AND model != ''").all() as { model: string }[];

  const tokenizerIds = new Set<string>();
  for (const { model } of rows) {
    const id = getTokenizerIdForModel(model);
    if (id) tokenizerIds.add(id);
  }

  if (tokenizerIds.size === 0) return;

  const labels: string[] = [];
  await Promise.allSettled(
    [...tokenizerIds].map(async (id) => {
      await getInstance(id);
      labels.push(id);
    })
  );

  if (labels.length > 0) {
    console.log("[Tokenizer] Pre-warmed: %s", labels.join(", "));
  }
}
