/**
 * Shared remote-file size cap. Without these guards, a single Buffer.from(
 * await res.arrayBuffer()) call could load a multi-GB remote file straight
 * into the heap and crash the process.
 *
 * Override per-deployment via env: LUMIVERSE_REMOTE_FILE_MAX_BYTES.
 */

const DEFAULT_REMOTE_FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

function readEnvCap(): number {
  const raw = process.env.LUMIVERSE_REMOTE_FILE_MAX_BYTES;
  if (!raw) return DEFAULT_REMOTE_FILE_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REMOTE_FILE_MAX_BYTES;
  return Math.floor(parsed);
}

export const MAX_REMOTE_FILE_BYTES = readEnvCap();

const DEFAULT_REMOTE_FETCH_TIMEOUT_MS = 30_000; // 30 s

function readEnvTimeout(): number {
  const raw = process.env.LUMIVERSE_REMOTE_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_REMOTE_FETCH_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REMOTE_FETCH_TIMEOUT_MS;
  return Math.floor(parsed);
}

/**
 * Per-request deadline for remote HTTP file providers (Dropbox, Google Drive).
 * Without this, a stalled remote read hangs the calling operation (browse,
 * validate, or an entire SillyTavern migration) indefinitely. Override via
 * LUMIVERSE_REMOTE_FETCH_TIMEOUT_MS.
 */
export const REMOTE_FETCH_TIMEOUT_MS = readEnvTimeout();

/**
 * Read a Response body into a Buffer, rejecting anything beyond `maxBytes`.
 * Honors Content-Length when present so we can fail fast on declared-large
 * payloads, and tracks the streamed total so chunked / unspecified-length
 * responses are still bounded.
 */
export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const n = parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(
        `Remote file "${label}" too large: ${n} bytes (max ${maxBytes})`,
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(
        `Remote file "${label}" exceeded ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}
