import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env";
import { safeFetch } from "../utils/safe-fetch";
import { hfAuthHeaders } from "./huggingface.service";

const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
type ResourceFormat = "text" | "json";

export function tokenizerFingerprint(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export interface TokenizerResource {
  text: string;
  source: "disk" | "network";
  expiresAt: number;
}

interface CacheOptions {
  directory: string;
  fetchText: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<string>;
  headers?: (url: string) => Promise<Record<string, string>>;
  ttlMs?: number;
  timeoutMs?: number;
  owner?: string;
}

/** Shared by main/worker runtimes through atomic files and exclusive lock files. */
export class TokenizerResourceCache {
  private pending = new Map<string, Promise<TokenizerResource>>();
  private lastPruned = 0;
  private owner: string;

  constructor(private options: CacheOptions) {
    this.owner = options.owner ?? crypto.randomUUID();
  }

  async read(url: string, fingerprint: string, format: ResourceFormat = "text"): Promise<TokenizerResource> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Tokenizer resources must use http or https");
    }
    const headers = await this.options.headers?.(url) ?? {};
    // Hash auth identity too: changing the configured HF token cannot reuse
    // resources downloaded with different credentials. Never persist headers.
    const key = tokenizerFingerprint(["tokenizer-resource-v1", url, fingerprint, headers, format]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.load(key, url, headers, format);
    this.pending.set(key, pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  /** Do not pin a successfully downloaded but unusable vocabulary for the TTL. */
  async discard(url: string, fingerprint: string, text: string, format: ResourceFormat = "text"): Promise<void> {
    try {
      const headers = await this.options.headers?.(url) ?? {};
      const key = tokenizerFingerprint(["tokenizer-resource-v1", url, fingerprint, headers, format]);
      const path = join(this.options.directory, `${key}.cache`);
      const current = await this.cached(path, format);
      // A newer download may have replaced the resource while construction ran.
      if (current?.text === text) await unlink(path);
    } catch { /* Best-effort, just like cache writes. */ }
  }

  private async cached(path: string, format: ResourceFormat): Promise<TokenizerResource | null> {
    try {
      const info = await stat(path);
      if (info.size > MAX_RESOURCE_BYTES + 256) return null;
      const content = await readFile(path, "utf8");
      const newline = content.indexOf("\n");
      const metadata = JSON.parse(content.slice(0, newline));
      const text = content.slice(newline + 1);
      if (metadata.version !== 1 || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= Date.now()
        || metadata.hash !== createHash("sha256").update(text).digest("hex")) return null;
      if (format === "json") JSON.parse(text);
      return { text, source: "disk", expiresAt: metadata.expiresAt };
    } catch { return null; }
  }

  private async download(url: string, headers: Record<string, string>, format: ResourceFormat): Promise<TokenizerResource> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? FETCH_TIMEOUT_MS);
    // Race as well as pass the signal: a fetch implementation/body reader that
    // ignores cancellation must not hold the generation or cache lock forever.
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const text = await Promise.race([this.options.fetchText(url, headers, signal), aborted]);
      if (Buffer.byteLength(text) > MAX_RESOURCE_BYTES) throw new Error("Tokenizer resource exceeds 128 MiB");
      if (format === "json") JSON.parse(text);
      return { text, source: "network", expiresAt: Date.now() + (this.options.ttlMs ?? CACHE_TTL_MS) };
    } finally { signal.removeEventListener("abort", onAbort); }
  }

  private async load(key: string, url: string, headers: Record<string, string>, format: ResourceFormat): Promise<TokenizerResource> {
    const path = join(this.options.directory, `${key}.cache`);
    const hit = await this.cached(path, format);
    if (hit) return hit;
    // An unavailable/full cache directory must not disable token counting.
    try { await mkdir(this.options.directory, { recursive: true }); }
    catch { return this.download(url, headers, format); }
    const lockPath = `${path}.lock`;
    const timeout = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
    const deadline = Date.now() + timeout + 5_000;
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error: any) {
        if (error.code !== "EEXIST") return this.download(url, headers, format);
        const hit = await this.cached(path, format);
        if (hit) return hit;
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > timeout + 5_000) {
            await unlink(lockPath).catch(() => {});
          }
        } catch { /* Another worker released it. */ }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for tokenizer resource cache");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const temporary = `${path}.${this.owner}.${crypto.randomUUID()}.tmp`;
    try {
      try { await lock.writeFile(this.owner); }
      catch { return this.download(url, headers, format); }
      const hit = await this.cached(path, format);
      if (hit) return hit;
      const result = await this.download(url, headers, format);
      const metadata = JSON.stringify({ version: 1,
        expiresAt: result.expiresAt,
        hash: createHash("sha256").update(result.text).digest("hex") });
      try {
        await writeFile(temporary, `${metadata}\n${result.text}`, { mode: 0o600 });
        await rename(temporary, path);
        await this.prune(path);
      } catch { /* Disk cache is best-effort; keep the downloaded resource. */ }
      return result;
    } finally {
      await unlink(temporary).catch(() => {});
      const heldLock = await lock.stat();
      await lock.close();
      // A stale lease may have been replaced while a worker was suspended.
      // Never remove the replacement worker's lock on completion.
      // (Atomic cache replacement makes concurrent downloads safe too.)
      const currentLock = await stat(lockPath).catch(() => null);
      if (currentLock?.ino === heldLock.ino) await unlink(lockPath).catch(() => {});
    }
  }

  private async prune(keep: string): Promise<void> {
    if (Date.now() - this.lastPruned < 60_000) return;
    this.lastPruned = Date.now();
    const entries = await Promise.all((await readdir(this.options.directory))
      .filter(name => /^[a-f0-9]{64}\.cache$/.test(name))
      .map(async name => {
        const path = join(this.options.directory, name);
        try { const info = await stat(path); return { path, size: info.size, time: info.mtimeMs }; }
        catch { return null; }
      }));
    const files = entries.filter(entry => entry !== null).sort((a, b) => a.time - b.time);
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.path === keep) continue;
      if (bytes <= MAX_CACHE_BYTES && Date.now() - file.time < (this.options.ttlMs ?? CACHE_TTL_MS)) continue;
      await unlink(file.path).catch(() => {});
      bytes -= file.size;
    }
  }
}

let cache: TokenizerResourceCache | undefined;
let resourceOwner = `main-${crypto.randomUUID()}`;

export function setTokenizerResourceOwner(owner: string): void {
  if (owner !== resourceOwner) { resourceOwner = owner; cache = undefined; }
}

/** Terminated workers cannot run finally blocks to release their file leases. */
export async function releaseTokenizerResourceLocks(owner: string, directory = join(env.dataDir, "cache", "tokenizers-v1")): Promise<void> {
  const names = await readdir(directory).catch(() => []);
  await Promise.all(names.filter(name => /^[a-f0-9]{64}\.cache\./.test(name)).map(async name => {
    const path = join(directory, name);
    try {
      if (name.endsWith(".lock") && await readFile(path, "utf8") === owner) await unlink(path);
      else if (name.endsWith(".tmp") && name.includes(`.cache.${owner}.`)) await unlink(path);
    } catch { /* Already released by the worker or another cleanup. */ }
  }));
}

export function readTokenizerResource(url: string, fingerprint: string, format: ResourceFormat = "text"): Promise<TokenizerResource> {
  cache ??= new TokenizerResourceCache({
    directory: join(env.dataDir, "cache", "tokenizers-v1"),
    headers: hfAuthHeaders,
    owner: resourceOwner,
    async fetchText(url, headers, signal) {
      const response = await safeFetch(url, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESOURCE_BYTES });
      if (!response.ok) throw new Error(`Tokenizer resource returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_RESOURCE_BYTES) {
        await response.body?.cancel();
        throw new Error("Tokenizer resource exceeds 128 MiB");
      }
      // Enforce the bound even when a server omits or lies about Content-Length.
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESOURCE_BYTES) throw new Error("Tokenizer resource exceeds 128 MiB");
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
      } finally { await reader.cancel().catch(() => {}); }
    },
  });
  return cache.read(url, fingerprint, format);
}

export async function discardTokenizerResource(url: string, fingerprint: string, text: string, format: ResourceFormat = "text"): Promise<void> {
  await cache?.discard(url, fingerprint, text, format);
}
