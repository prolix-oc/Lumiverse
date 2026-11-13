import { throwProviderResponseError } from "../../utils/provider-errors";

/** A source image resolved upstream (manual uploads + character/persona avatars). */
export interface SourceImage {
  data: string;
  mimeType?: string;
}

/** Trim trailing slashes from a configured base URL. */
export function trimBaseUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

/**
 * Inline an http(s) image URL (or a data URL) as a base64 data URL.
 *
 * Several providers (BFL, Ideogram, Civitai, Stability) hand back result URLs
 * that expire within minutes, so results are downloaded immediately rather
 * than stored as a link.
 */
export async function toDataUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith("data:")) return url;
  // Bun's fetch also reads file:// URLs. Provider results must never select
  // local files from the server hosting this connection.
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider image URLs must use HTTP or HTTPS");
  }
  const res = await fetch(url, { signal });
  if (!res.ok) await throwProviderResponseError("Image", "image fetch", res);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Split a raw base64 string or data URL into bytes + MIME type. */
export function decodeImage(src: SourceImage): { bytes: Buffer<ArrayBuffer>; mimeType: string } {
  let base64 = src.data;
  let mimeType = src.mimeType || "image/png";
  const match = base64.match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (match) {
    if (match[1]) mimeType = match[1];
    base64 = match[2];
  }
  return { bytes: Buffer.from(base64, "base64"), mimeType };
}

/** Normalize a source image to a full data URL. */
export function asDataUrl(src: SourceImage): string {
  return src.data.startsWith("data:")
    ? src.data
    : `data:${src.mimeType || "image/png"};base64,${src.data}`;
}

/** The source images a request carries, preferring the resolved set. */
export function sourceImages(parameters: Record<string, any>): SourceImage[] {
  const sources: SourceImage[] = parameters.resolvedSourceImages || parameters.referenceImages || [];
  return sources.filter((s) => !!s?.data);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollOptions<T> {
  /** Performs one status check; returns the terminal value or `null` to keep waiting. */
  check: () => Promise<{ done: boolean; value?: T; error?: string }>;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll an async provider job until it completes, fails, or times out.
 *
 * Used by every submit-and-poll provider (BFL, fal, Leonardo, Replicate,
 * Civitai, Runware async). The interval is constant; providers that document a
 * different cadence still converge well within their own result windows.
 */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<T> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    const status = await opts.check();
    if (status.done) {
      if (status.error) throw new Error(status.error);
      return status.value as T;
    }
    if (Date.now() >= deadline) throw new Error("Provider job timed out");
    await sleep(intervalMs, opts.signal);
  }
}

/** Build an `Authorization: Bearer` header object. */
export function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
