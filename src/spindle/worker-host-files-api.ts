import { ZipArchive, type ZipEntryData } from "archiver";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { safeFetch } from "../utils/safe-fetch";
import { extractSelectedZipEntries, MAX_DECOMPRESSED_BYTES } from "../services/user-data/import.service";
import { getUpload, pinUpload } from "./uploads";
import {
  assertArchiveName, assertFileSize, createStagedFile, fileDownloadUrl, fileRef, finishStagedFile,
  ownedStagedFile, persistFile, pinStagedFile, readFileChunk, removeSessionFiles, removeStagedFile,
  writeFileChunk, type FileOwner, type StagedFile,
} from "./files";
import {
  SPINDLE_FILE_DEFAULT_MAX_BYTES as FILE_DEFAULT_MAX_BYTES,
  SPINDLE_FILE_MAX_COUNT as FILE_MAX_COUNT,
  type FileTransferWorkerMessage,
  type SpindleFileSource,
} from "lumiverse-spindle-types";

export interface WorkerHostFilesApiOptions {
  extensionId: string;
  identifier: string;
  hasPermission(permission: "cors_proxy"): boolean;
  resolveEffectiveUserId(userId?: string): string | undefined;
  enforceScopedUser(userId: string): void;
  postResponse(message: { type: "response"; requestId: string; result?: unknown; error?: string }): void;
}

/** Owns all resources created by one worker lifetime, including cancellation. */
export class WorkerHostFilesApi {
  private readonly sessionId = crypto.randomUUID();
  private readonly operations = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly options: WorkerHostFilesApiOptions) {}

  dispatch(message: { type: string; [key: string]: unknown }): boolean {
    if (![
      "files_fetch", "files_create", "files_write_chunk", "files_finish", "files_delete",
      "files_download_url", "files_read_chunk", "archives_create", "archives_extract", "files_cancel",
    ].includes(message.type)) return false;
    const msg = message as FileTransferWorkerMessage;
    if (msg.type === "files_cancel") {
      this.operations.get(msg.operationId)?.abort(new DOMException("File operation cancelled", "AbortError"));
      return true;
    }
    if (this.tasks.size >= 8 || this.operations.has(msg.requestId)) {
      this.options.postResponse({ type: "response", requestId: msg.requestId, error: "Too many concurrent file operations or duplicate requestId" });
      return true;
    }
    const controller = new AbortController();
    this.operations.set(msg.requestId, controller);
    const task = this.handle(msg, controller.signal).then(
      result => this.options.postResponse({ type: "response", requestId: msg.requestId, result }),
      error => this.options.postResponse({
        type: "response", requestId: msg.requestId,
        error: controller.signal.aborted ? "AbortError: File operation cancelled" : error instanceof Error ? error.message : String(error),
      }),
    ).catch(error => console.warn("[spindle-files] response delivery failed", error)).finally(() => {
      this.operations.delete(msg.requestId);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.operations.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
    removeSessionFiles(this.sessionId);
  }

  private owner(userId?: string): FileOwner {
    if (this.disposed) throw new Error("Extension file service is stopped");
    const resolved = this.options.resolveEffectiveUserId(userId);
    if (!resolved) throw new Error("userId is required for operator-scoped extensions");
    this.options.enforceScopedUser(resolved);
    return { extensionId: this.options.extensionId, identifier: this.options.identifier, userId: resolved, sessionId: this.sessionId };
  }

  private requireCors(): void {
    if (!this.options.hasPermission("cors_proxy")) throw new Error(`${PERMISSION_DENIED_PREFIX} cors_proxy — CORS proxy permission not granted`);
  }

  private source(owner: FileOwner, source: SpindleFileSource): { path: string; size: number; release(): void } {
    if (!source || typeof source !== "object" || ("fileId" in source) === ("uploadId" in source)) throw new Error("Specify exactly one fileId or uploadId");
    if ("fileId" in source) {
      const rec = ownedStagedFile(owner, source.fileId);
      if (!rec.complete) throw new Error("File is incomplete");
      return { path: rec.path, size: rec.size, release: pinStagedFile(rec) };
    }
    const upload = getUpload(source.uploadId);
    if (!upload || upload.extensionIdentifier !== owner.identifier || upload.ownerUserId !== owner.userId) throw new Error("Upload not found or expired");
    if (upload.offset !== upload.declaredSize) throw new Error("Upload is incomplete");
    return { path: upload.path, size: upload.declaredSize, release: pinUpload(upload) };
  }

  private async handle(msg: Exclude<FileTransferWorkerMessage, { type: "files_cancel" }>, signal: AbortSignal): Promise<unknown> {
    const userId = "options" in msg ? msg.options?.userId : "input" in msg ? msg.input?.userId : msg.userId;
    const owner = this.owner(userId);
    signal.throwIfAborted();
    switch (msg.type) {
      case "files_fetch": {
        this.requireCors();
        const maxBytes = msg.options.maxBytes ?? FILE_DEFAULT_MAX_BYTES;
        assertFileSize(maxBytes);
        const timeoutMs = msg.options.timeoutMs ?? 30 * 60 * 1000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000) throw new Error("timeoutMs must be between 1 and 3600000");
        const rec = createStagedFile(owner, msg.options.fileName ?? "download.bin", maxBytes);
        const release = pinStagedFile(rec);
        let response: Response | undefined;
        try {
          // Match spindle.cors's private-network policy, URL validation, and
          // credential stripping on redirects; safeFetch caps actual bytes.
          response = await safeFetch(msg.url, { headers: msg.options.headers, maxBytes, timeoutMs, signal, allowPrivate: true });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Download failed: HTTP ${response.status}`);
          }
          signal.throwIfAborted();
          const type = response.headers.get("content-type")?.split(";")[0].trim();
          if (type && type.length <= 255 && !/[\r\n\x00]/.test(type)) rec.mimeType = type;
          return await persistFile(rec, response.body ?? new ReadableStream({ start(c) { c.close(); } }), signal, () => this.requireCors());
        } catch (error) {
          await response?.body?.cancel().catch(() => {});
          release();
          if (!rec.pins) removeStagedFile(rec);
          throw error;
        } finally { release(); }
      }
      case "files_create": {
        if (msg.input.size !== undefined && msg.input.maxBytes !== undefined) throw new Error("Specify size or maxBytes, not both");
        const rec = createStagedFile(owner, msg.input.fileName, msg.input.size ?? msg.input.maxBytes ?? FILE_DEFAULT_MAX_BYTES, msg.input.mimeType);
        rec.expectedSize = msg.input.size;
        try {
          writeFileSync(rec.path, "", { flag: "wx" });
          return fileRef(rec);
        } catch (error) { removeStagedFile(rec); throw error; }
      }
      case "files_write_chunk": return writeFileChunk(ownedStagedFile(owner, msg.fileId), msg.offset, msg.data);
      case "files_finish": {
        const rec = ownedStagedFile(owner, msg.fileId);
        if (rec.pins) throw new Error("File is in use");
        if (rec.complete) return fileRef(rec);
        return finishStagedFile(rec, rec.expectedSize);
      }
      case "files_delete": {
        // Unknown and foreign ids reveal the same result.
        let rec: StagedFile;
        try { rec = ownedStagedFile(owner, msg.fileId); } catch { return false; }
        removeStagedFile(rec);
        return true;
      }
      case "files_download_url": {
        const rec = ownedStagedFile(owner, msg.fileId);
        if (!rec.complete) throw new Error("File is incomplete");
        return fileDownloadUrl(rec);
      }
      case "files_read_chunk": {
        const source = this.source(owner, msg.source);
        try { return await readFileChunk(source.path, source.size, msg.offset); }
        finally { source.release(); }
      }
      case "archives_create": return this.createArchive(owner, msg, signal);
      case "archives_extract": return this.extractArchive(owner, msg, signal);
    }
  }

  private async createArchive(owner: FileOwner, msg: Extract<FileTransferWorkerMessage, { type: "archives_create" }>, signal: AbortSignal): Promise<unknown> {
    if (!Array.isArray(msg.entries) || msg.entries.length > FILE_MAX_COUNT) throw new Error(`Archive must have at most ${FILE_MAX_COUNT} entries`);
    const sources: Array<{ name: string; path: string; store: boolean; release(): void }> = [];
    let rec: StagedFile | undefined;
    const archive = new ZipArchive({ forceZip64: true, zlib: { level: 3 } });
    archive.on("warning", error => archive.destroy(error));
    try {
      const names = new Set<string>();
      let nameBytes = 0;
      for (const entry of msg.entries) {
        assertArchiveName(entry.name);
        nameBytes += Buffer.byteLength(entry.name);
        if (nameBytes > 1024 * 1024 || entry.name.endsWith("/") || names.has(entry.name)) throw new Error("Invalid or duplicate archive entry name");
        names.add(entry.name);
        const source = this.source(owner, entry.source);
        sources.push({ name: entry.name, path: source.path, store: entry.store === true, release: source.release });
      }
      rec = createStagedFile(owner, msg.options.fileName ?? "export.zip", msg.options.maxBytes ?? FILE_DEFAULT_MAX_BYTES, "application/zip");
      // Attach the pipeline before appending so archiver errors are observed.
      const writing = persistFile(rec, archive, signal);
      try {
        for (const source of sources) {
          const entryOptions: ZipEntryData = { name: source.name, store: source.store };
          archive.file(source.path, entryOptions);
        }
        // finalize can resolve before the output file has drained; await both.
        await Promise.all([archive.finalize(), writing]);
        return fileRef(rec);
      } catch (error) {
        archive.abort();
        archive.destroy(error instanceof Error ? error : new Error(String(error)));
        await writing.catch(() => {});
        throw error;
      }
    } catch (error) {
      if (rec && !rec.pins) removeStagedFile(rec);
      throw error;
    } finally {
      for (const source of sources) source.release();
    }
  }

  private async extractArchive(owner: FileOwner, msg: Extract<FileTransferWorkerMessage, { type: "archives_extract" }>, signal: AbortSignal): Promise<unknown> {
    const maximum = msg.options.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
    assertFileSize(maximum, MAX_DECOMPRESSED_BYTES);
    if (maximum === 0) throw new Error("maxDecompressedBytes must be positive");
    const requested = msg.options.entries;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > FILE_MAX_COUNT)) throw new Error("Too many selected entries");
    for (const name of requested ?? []) assertArchiveName(name);
    const selection = requested === undefined ? undefined : new Set(requested);
    const source = this.source(owner, msg.source);
    const children = new Map<string, StagedFile>();
    let reservation: StagedFile | undefined;
    const releases: Array<() => void> = [];
    try {
      reservation = createStagedFile(owner, "extraction", maximum);
      releases.push(pinStagedFile(reservation));
      const destinationDir = dirname(reservation.directory);
      let nameBytes = 0;
      await extractSelectedZipEntries({
        archivePath: source.path, destinationDir, signal, maxDecompressedBytes: maximum,
        selectEntry(name) {
          signal.throwIfAborted();
          if (selection && !selection.has(name)) return null;
          assertArchiveName(name);
          if (name.endsWith("/")) return null;
          let child = children.get(name);
          if (!child) {
            nameBytes += Buffer.byteLength(name);
            if (nameBytes > 1024 * 1024) throw new Error("Archive entry names are too large");
            child = createStagedFile(owner, name.split("/").pop()!, 0);
            releases.push(pinStagedFile(child));
            children.set(name, child);
          }
          return `${child.fileId}/blob`;
        },
        validateSelection() {
          if (selection && [...selection].some(name => !children.has(name))) throw new Error("Selected archive entry not found");
        },
      });
      signal.throwIfAborted();
      const result = [];
      for (const [name, child] of children) {
        // Move the reservation into each finished child without double-counting.
        const size = Bun.file(child.path).size;
        reservation.budget -= size;
        child.budget = size;
        result.push({ name, file: finishStagedFile(child) });
      }
      return result;
    } catch (error) {
      for (const release of releases) release();
      for (const child of children.values()) removeStagedFile(child);
      throw error;
    } finally {
      for (const release of releases) release();
      if (reservation) removeStagedFile(reservation);
      source.release();
    }
  }
}
