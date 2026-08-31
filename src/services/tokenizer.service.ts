import { getDb } from "../db/connection";
import type { TokenizerConfig, TokenizerModelPattern, TokenCountResult, TokenCountBreakdownEntry, TokenizerType } from "../types/tokenizer";
import { getTextContent, type AssemblyBreakdownEntry, type LlmMessage } from "../llm/types";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { hfAuthHeaders } from "./huggingface.service";

export interface TokenCountMessageLike {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Validate a tokenizer resource URL before fetching. Owner-supplied, but still
 * should not reach private/internal hosts.
 */
/**
 * Deadline for fetching remote tokenizer / vocab files (one-time, then cached).
 * Without it, a reachable-but-hung host stalls token counting on the live
 * generation path indefinitely (a hang never throws, so the char/4 fallback
 * would never engage). On timeout the fetch throws and the fallback kicks in.
 */
const TOKENIZER_FETCH_TIMEOUT_MS = 30_000;

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

/** Display name reported when no real tokenizer could be resolved for a model. */
export const APPROXIMATE_TOKENIZER_NAME = "approximate";

/** Bound extension-host batch token-counting work to keep a worker turn responsive. */
export const MAX_COUNT_BATCH_TEXTS = 64;
/** Yield periodically while counting extension-host token batches. */
export const COUNT_BATCH_YIELD_EVERY = 8;

/** A loaded tokenizer instance with a count(text) method. */
interface TokenizerInstance {
  count: (text: string) => number;
}

export interface ResolvedTokenCounter {
  readonly count: (text: string) => number;
  readonly name: string;
}

// ---- Caches ----
const MAX_CACHED_TOKENIZER_INSTANCES = 5;
const MAX_PREWARM_TOKENIZERS = MAX_CACHED_TOKENIZER_INSTANCES;

const instanceCache = new Map<string, TokenizerInstance>();
const pendingInstanceLoads = new Map<string, Promise<TokenizerInstance>>();
let patternCache: { patterns: { regex: RegExp; tokenizerId: string }[] } | null = null;

// ---- Token-count memoization ----
// `count(text)` for a fixed tokenizer is a pure function, and the dominant cost
// of context-budget clipping is re-encoding chat history that hasn't changed
// since the last generation (regenerate / swipe / continue / next turn all
// re-tokenize the same surviving messages). Memoizing by content turns that
// O(chars) BPE encode into an O(chars) hash + Map lookup — ~100-150x faster on
// the slow HuggingFace tokenizers (Claude, GLM) in practice.
//
// The key is content-derived, so it's automatically correct across message
// edits, macro expansion, and swipes: any change to the encoded text yields a
// different key → cache miss → fresh encode. `length` is folded into the key so
// a hash collision additionally needs an identical length to misfire (and even
// then the only consequence is an off-by-a-little budget estimate, already
// within the clip's safety margin).
const TOKEN_COUNT_CACHE_MAX = 50_000;
const tokenCountCache = new Map<string, number>();

/** Fast, non-cryptographic 53-bit string hash (cyrb53). */
function hashText(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Memoized `instance.count(text)`, keyed by (tokenizerId, length, content hash). */
function countCached(
  tokenizerId: string,
  instance: TokenizerInstance,
  text: string,
): number {
  const key = `${tokenizerId}\u0000${text.length}\u0000${hashText(text)}`;
  const hit = tokenCountCache.get(key);
  if (hit !== undefined) return hit;
  const value = instance.count(text);
  // Bounded FIFO eviction — entries are tiny (~short key + number), and the
  // oldest are the least likely to belong to an actively-regenerating chat.
  if (tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX) {
    const oldest = tokenCountCache.keys().next().value;
    if (oldest !== undefined) tokenCountCache.delete(oldest);
  }
  tokenCountCache.set(key, value);
  return value;
}

// ---- Helpers ----

const BENIGN_TOKENIZER_CLASS_WARNING =
  'Unknown tokenizer class "TokenizersBackend", attempting to construct from base class.';

function isBenignTokenizerWarning(args: unknown[]): boolean {
  return args.length > 0 && String(args[0]) === BENIGN_TOKENIZER_CLASS_WARNING;
}

function withoutBenignTokenizerWarning<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!isBenignTokenizerWarning(args)) {
      originalWarn(...args);
    }
  };
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

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
        const tokenizer = withoutBenignTokenizerWarning(() => mod.fromPreTrained());
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
      const resp = await fetch(cfg.url, { signal: AbortSignal.timeout(TOKENIZER_FETCH_TIMEOUT_MS), headers: await hfAuthHeaders(cfg.url) });
      if (!resp.ok) throw new Error(`Failed to fetch tokenizer.json from ${cfg.url}: ${resp.status}`);
      const tokenizerJSON = await resp.json();
      const tokenizer = withoutBenignTokenizerWarning(() => TokenizerLoader.fromPreTrained({
        tokenizerJSON,
        tokenizerConfig: { tokenizer_class: "PreTrainedTokenizer" },
      }));
      return { count: (text: string) => tokenizer.encode(text).length };
    }

    // Fetch both files ourselves so warning suppression is scoped only to construction,
    // not the whole network request inside fromPreTrainedUrls().
    await validateTokenizerUrl(cfg.url, "tokenizer url");
    await validateTokenizerUrl(configUrl, "tokenizer config url");
    const tokenizerResp = await fetch(cfg.url, { signal: AbortSignal.timeout(TOKENIZER_FETCH_TIMEOUT_MS), headers: await hfAuthHeaders(cfg.url) });
    if (!tokenizerResp.ok) throw new Error(`Failed to fetch tokenizer.json from ${cfg.url}: ${tokenizerResp.status}`);
    const configResp = await fetch(configUrl, { signal: AbortSignal.timeout(TOKENIZER_FETCH_TIMEOUT_MS), headers: await hfAuthHeaders(configUrl) });
    if (!configResp.ok) throw new Error(`Failed to fetch tokenizer_config.json from ${configUrl}: ${configResp.status}`);
    const tokenizerJSON = await tokenizerResp.json();
    const tokenizerConfig = await configResp.json();
    const tokenizer = withoutBenignTokenizerWarning(() =>
      TokenizerLoader.fromPreTrained({ tokenizerJSON, tokenizerConfig })
    );
    return { count: (text: string) => tokenizer.encode(text).length };
  }

  throw new Error("HuggingFace tokenizer requires either 'package' or 'url' in config");
}

/**
 * Detect the OpenAI-canonical tiktoken `.model` format: many lines of
 * `<base64_token> <rank>`. js-tiktoken ships its own compressed format instead,
 * so we probe the first non-empty line to decide whether to convert.
 */
function looksLikeStandardTiktokenFormat(bpe: string): boolean {
  const firstLineEnd = bpe.indexOf("\n");
  if (firstLineEnd < 0) return false; // single line — already compressed
  const firstLine = bpe.slice(0, firstLineEnd).trim();
  // Standard row: exactly two whitespace-separated fields, second is an integer.
  const parts = firstLine.split(/\s+/);
  return parts.length === 2 && /^\d+$/.test(parts[1]);
}

/**
 * Convert the OpenAI standard `<base64> <rank>\n` format into the single-line
 * compressed format js-tiktoken's `Tiktoken` constructor parses. Ranks must be
 * contiguous starting at 0 (standard tiktoken files already satisfy this).
 */
function convertStandardToCompressedBpe(standard: string): string {
  const lines = standard.split("\n");
  const tokens: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const tok = line.slice(0, sp);
    const rank = Number.parseInt(line.slice(sp + 1), 10);
    if (!Number.isFinite(rank)) continue;
    if (rank !== tokens.length) {
      throw new Error(`tiktoken model ranks are non-contiguous at index ${tokens.length} (got rank ${rank})`);
    }
    tokens.push(tok);
  }
  // Leading `! 0` is the sentinel + starting offset js-tiktoken's parser expects.
  return `! 0 ${tokens.join(" ")}`;
}

async function loadTiktoken(config: TokenizerConfig): Promise<TokenizerInstance> {
  const { Tiktoken } = await import("js-tiktoken/lite");
  const cfg = config.config;
  if (!cfg.url) throw new Error("Tiktoken requires 'url' in config pointing to .model file");

  await validateTokenizerUrl(cfg.url, "tiktoken model url");
  const resp = await fetch(cfg.url, { signal: AbortSignal.timeout(TOKENIZER_FETCH_TIMEOUT_MS), headers: await hfAuthHeaders(cfg.url) });
  if (!resp.ok) throw new Error(`Failed to fetch tiktoken model from ${cfg.url}`);
  const rawBpe = await resp.text();

  // js-tiktoken's constructor expects its own compressed rank format
  // (`<sentinel> <offset> <tok0> <tok1> ...` on a single line — see
  // `js-tiktoken/dist/ranks/o200k_base.js`). The standard OpenAI tiktoken
  // format (one `<base64> <rank>` pair per line, shipped by e.g. Moonshot's
  // Kimi-K2.5/tiktoken.model) is different, so we transparently convert it.
  const bpeData = looksLikeStandardTiktokenFormat(rawBpe)
    ? convertStandardToCompressedBpe(rawBpe)
    : rawBpe;

  // Parse special tokens from tokenizer_config.json if provided
  let specialTokens: Record<string, number> = {};
  if (cfg.configUrl) {
    try {
      await validateTokenizerUrl(cfg.configUrl, "tiktoken config url");
      const configResp = await fetch(cfg.configUrl, { signal: AbortSignal.timeout(TOKENIZER_FETCH_TIMEOUT_MS), headers: await hfAuthHeaders(cfg.configUrl) });
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

function touchInstance(tokenizerId: string, instance: TokenizerInstance): void {
  if (instanceCache.get(tokenizerId) === instance) {
    instanceCache.delete(tokenizerId);
  }
  instanceCache.set(tokenizerId, instance);

  while (instanceCache.size > MAX_CACHED_TOKENIZER_INSTANCES) {
    const oldest = instanceCache.keys().next().value;
    if (oldest === undefined) break;
    instanceCache.delete(oldest);
  }
}

async function getInstance(tokenizerId: string): Promise<TokenizerInstance> {
  const cached = instanceCache.get(tokenizerId);
  if (cached) {
    touchInstance(tokenizerId, cached);
    return cached;
  }

  const pending = pendingInstanceLoads.get(tokenizerId);
  if (pending) return pending;

  const config = getConfig(tokenizerId);
  if (!config) throw new Error(`Tokenizer not found: ${tokenizerId}`);

  const loadPromise = (async () => {
    const instance = await loadTokenizer(config);
    touchInstance(tokenizerId, instance);
    return instance;
  })();

  pendingInstanceLoads.set(tokenizerId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (pendingInstanceLoads.get(tokenizerId) === loadPromise) {
      pendingInstanceLoads.delete(tokenizerId);
    }
  }
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
  if (!text) return 0;
  return countCached(tokenizerId, instance, text);
}

/**
 * Attempt to load an ad-hoc tokenizer config (without persisting it or touching
 * the instance cache) and run a sample encode. Used by the "resolve from repo"
 * flow to prove a tokenizer is actually usable before we install it — file
 * existence alone doesn't catch SentencePiece-only repos or custom formats our
 * loaders can't parse (e.g. Grok's `tokenizer.tok.json`).
 */
export async function verifyConfig(
  type: TokenizerType,
  config: Record<string, any>
): Promise<{ ok: true; sampleTokens: number } | { ok: false; error: string }> {
  const synthetic: TokenizerConfig = {
    id: "__verify__",
    name: "__verify__",
    type,
    config: config || {},
    is_built_in: false,
    created_at: 0,
    updated_at: 0,
  };
  try {
    const instance = await loadTokenizer(synthetic);
    const sampleTokens = instance.count("The quick brown fox jumps over the lazy dog.");
    return { ok: true, sampleTokens };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function flattenMessagesForTokenCount(messages: TokenCountMessageLike[]): string {
  return messages.map((msg) => `${msg.role}\n${msg.content || ""}`).join("\n");
}

export async function countMessagesForModel(
  modelId: string,
  messages: TokenCountMessageLike[]
): Promise<number | null> {
  return await countForModel(modelId, flattenMessagesForTokenCount(messages));
}

export async function countBreakdown(
  modelId: string,
  breakdown: AssemblyBreakdownEntry[],
  chatHistoryMessages?: LlmMessage[]
): Promise<TokenCountResult> {
  const tokenizerId = modelId ? getTokenizerIdForModel(modelId) : null;
  const { count: countText, name: tokenizerName } = await resolveCounter(modelId);

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
      const bulk = flattenMessagesForTokenCount(
        chatHistoryMessages.map((msg) => ({ role: msg.role, content: getTextContent(msg) }))
      );
      tokens = countText(bulk);
    } else {
      tokens = countText(entry.tokenCountContent ?? entry.content ?? "");
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
      extensionId: entry.extensionId,
      extensionName: entry.extensionName,
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
 * Resolve only a concrete tokenizer. Approximate configs, unknown models, and
 * missing configs return null; loader/count failures remain visible so a
 * security-sensitive caller can choose its own conservative fallback.
 */
export async function resolveStrictCounter(
  modelId: string,
): Promise<ResolvedTokenCounter | null> {
  const tokenizerId = modelId ? getTokenizerIdForModel(modelId) : null;
  if (!tokenizerId) return null;
  const config = getConfig(tokenizerId);
  if (!config || config.type === "approximate") return null;
  const instance = await getInstance(tokenizerId);
  return {
    count: (text: string) => text ? countCached(tokenizerId, instance, text) : 0,
    name: config.name || tokenizerId,
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
export async function resolveCounter(modelId: string): Promise<ResolvedTokenCounter> {
  const tokenizerId = modelId ? getTokenizerIdForModel(modelId) : null;
  if (tokenizerId) {
    const config = getConfig(tokenizerId);
    try {
      const instance = await getInstance(tokenizerId);
      const name = config?.name || tokenizerId;
      return {
        count: (text: string) => {
          if (!text) return 0;
          try { return countCached(tokenizerId, instance, text); } catch { return Math.ceil(text.length / 4); }
        },
        name,
      };
    } catch {
      // fall through to approximate
    }
  }
  return {
    count: (text: string) => (text ? Math.ceil(text.length / 4) : 0),
    name: APPROXIMATE_TOKENIZER_NAME,
  };
}

export { getTokenizerIdForModel, getAllConfigs, getConfig, getAllPatterns };

export function invalidate(tokenizerId: string): void {
  instanceCache.delete(tokenizerId);
  pendingInstanceLoads.delete(tokenizerId);
  // The tokenizer's encoding may have changed — drop its memoized counts so we
  // don't serve stale token totals from before the config edit.
  const prefix = `${tokenizerId}\u0000`;
  for (const key of tokenCountCache.keys()) {
    if (key.startsWith(prefix)) tokenCountCache.delete(key);
  }
}

export function invalidatePatterns(): void {
  patternCache = null;
}

/**
 * Pre-warm tokenizer instances for the most likely startup targets: each user's
 * active connection, then their default connection, then a most-recently-edited
 * fallback only when neither exists. The result is capped to the instance-cache
 * size so startup never drags a long tail of rarely used tokenizers into RAM.
 *
 * Intended to be called fire-and-forget at startup — failures are non-fatal.
 */
export async function prewarm(): Promise<void> {
  const tokenizerIds = collectPrewarmTokenizerIds();
  if (tokenizerIds.length === 0) return;

  const labels: string[] = [];
  for (const id of tokenizerIds) {
    try {
      await getInstance(id);
      labels.push(id);
    } catch {
      // non-fatal
    }
  }

  if (labels.length > 0) {
    console.log("[Tokenizer] Pre-warmed: %s", labels.join(", "));
  }
}

type PrewarmConnectionRow = {
  id: string;
  user_id: string | null;
  model: string;
  is_default: number;
  updated_at: number;
};

type PrewarmSettingRow = {
  user_id: string | null;
  value: string;
  updated_at: number;
};

type PrewarmCandidate = {
  connectionId: string;
  model: string;
  priority: number;
  updatedAt: number;
};

function userScopeKey(userId: string | null): string {
  return userId ?? "__global__";
}

function parseSettingString(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

function collectPrewarmTokenizerIds(): string[] {
  const db = getDb();
  const connections = db.query(
    "SELECT id, user_id, model, is_default, updated_at FROM connection_profiles WHERE model IS NOT NULL AND model != ''"
  ).all() as PrewarmConnectionRow[];
  if (connections.length === 0) return [];

  const activeSettings = db.query(
    "SELECT user_id, value, updated_at FROM settings WHERE key = ?"
  ).all("activeProfileId") as PrewarmSettingRow[];

  const connectionsByUser = new Map<string, PrewarmConnectionRow[]>();
  for (const row of connections) {
    const key = userScopeKey(row.user_id);
    const existing = connectionsByUser.get(key);
    if (existing) {
      existing.push(row);
    } else {
      connectionsByUser.set(key, [row]);
    }
  }

  const activeByUser = new Map<string, { connectionId: string; updatedAt: number }>();
  for (const row of activeSettings) {
    const connectionId = parseSettingString(row.value);
    if (!connectionId) continue;
    activeByUser.set(userScopeKey(row.user_id), {
      connectionId,
      updatedAt: Number(row.updated_at ?? 0),
    });
  }

  const candidates: PrewarmCandidate[] = [];
  for (const [key, userConnections] of connectionsByUser) {
    userConnections.sort(
      (a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0) || a.id.localeCompare(b.id)
    );

    const selected = new Set<string>();
    const active = activeByUser.get(key);
    if (active) {
      const match = userConnections.find((row) => row.id === active.connectionId);
      if (match) {
        selected.add(match.id);
        candidates.push({
          connectionId: match.id,
          model: match.model,
          priority: 0,
          updatedAt: active.updatedAt,
        });
      }
    }

    const defaultConnection = userConnections.find((row) => !!row.is_default);
    if (defaultConnection && !selected.has(defaultConnection.id)) {
      selected.add(defaultConnection.id);
      candidates.push({
        connectionId: defaultConnection.id,
        model: defaultConnection.model,
        priority: 1,
        updatedAt: Number(defaultConnection.updated_at ?? 0),
      });
    }

    if (selected.size === 0 && userConnections.length > 0) {
      const fallback = userConnections[0];
      candidates.push({
        connectionId: fallback.id,
        model: fallback.model,
        priority: 2,
        updatedAt: Number(fallback.updated_at ?? 0),
      });
    }
  }

  candidates.sort(
    (a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt || a.connectionId.localeCompare(b.connectionId)
  );

  const tokenizerIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const tokenizerId = getTokenizerIdForModel(candidate.model);
    if (!tokenizerId || seen.has(tokenizerId)) continue;
    seen.add(tokenizerId);
    tokenizerIds.push(tokenizerId);
    if (tokenizerIds.length >= MAX_PREWARM_TOKENIZERS) break;
  }
  return tokenizerIds;
}

/** Release reconstructable tokenizer state when the host reports low memory. */
export function releaseTokenizerMemory(): void {
  instanceCache.clear();
  tokenCountCache.clear();
}

/** @internal Only intended for unit tests — resets in-memory state. */
export function _resetForTests(): void {
  releaseTokenizerMemory();
  pendingInstanceLoads.clear();
  patternCache = null;
}

/** @internal Only intended for unit tests — exposes current LRU order. */
export function _getCachedTokenizerIdsForTests(): string[] {
  return [...instanceCache.keys()];
}
