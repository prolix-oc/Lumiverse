import type { ExtensionInfo } from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, relative, resolve, sep } from "path";
import * as managerSvc from "./manager.service";
import { getEphemeralPoolConfig } from "./ephemeral-pool.service";
import { getUserExtensionPath } from "../auth/provision";
import {
  deleteSecret,
  getSecret,
  listSecretKeys,
  putSecret,
  validateSecret,
} from "../services/secrets.service";

const EPHEMERAL_MAX_FILES = 250;
const ENCLAVE_KEY_PATTERN = /^[a-zA-Z0-9_\-.]{1,128}$/;
const ENCLAVE_MAX_VALUE_BYTES = 64 * 1024;

type Reservation = {
  id: string;
  sizeBytes: number;
  consumedBytes: number;
  createdAt: string;
  expiresAt: string;
  reason?: string;
};

export type WorkerHostStorageApiOptions = {
  identifier: string;
  installScope: "operator" | "user";
  installedByUserId: string | null;
  hasPermission: (permission: "ephemeral_storage") => boolean;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};

/**
 * Stateful filesystem and secret-store boundary for one Spindle extension.
 *
 * The worker host owns transport and permission context; this module owns
 * path resolution, quota bookkeeping, and all storage API implementations.
 */
export class WorkerHostStorageApi {
  constructor(private readonly options: WorkerHostStorageApiOptions) {}

  /** Returns true when this API family owns the worker message. */
  dispatch(message: { type: string; [key: string]: unknown }): boolean {
    const msg = message as any;
    switch (msg.type) {
      case "storage_read": this.handleStorageRead(msg.requestId, msg.path); return true;
      case "storage_write": this.handleStorageWrite(msg.requestId, msg.path, msg.data); return true;
      case "storage_read_binary": this.handleStorageReadBinary(msg.requestId, msg.path); return true;
      case "storage_write_binary": this.handleStorageWriteBinary(msg.requestId, msg.path, msg.data); return true;
      case "storage_delete": this.handleStorageDelete(msg.requestId, msg.path); return true;
      case "storage_list": this.handleStorageList(msg.requestId, msg.prefix); return true;
      case "storage_exists": this.handleStorageExists(msg.requestId, msg.path); return true;
      case "storage_mkdir": this.handleStorageMkdir(msg.requestId, msg.path); return true;
      case "storage_move": this.handleStorageMove(msg.requestId, msg.from, msg.to); return true;
      case "storage_stat": this.handleStorageStat(msg.requestId, msg.path); return true;
      case "user_storage_read": this.handleUserStorageRead(msg.requestId, msg.path, msg.userId); return true;
      case "user_storage_write": this.handleUserStorageWrite(msg.requestId, msg.path, msg.data, msg.userId); return true;
      case "user_storage_read_binary": this.handleUserStorageReadBinary(msg.requestId, msg.path, msg.userId); return true;
      case "user_storage_write_binary": this.handleUserStorageWriteBinary(msg.requestId, msg.path, msg.data, msg.userId); return true;
      case "user_storage_delete": this.handleUserStorageDelete(msg.requestId, msg.path, msg.userId); return true;
      case "user_storage_list": this.handleUserStorageList(msg.requestId, msg.prefix, msg.userId); return true;
      case "user_storage_exists": this.handleUserStorageExists(msg.requestId, msg.path, msg.userId); return true;
      case "user_storage_mkdir": this.handleUserStorageMkdir(msg.requestId, msg.path, msg.userId); return true;
      case "user_storage_move": this.handleUserStorageMove(msg.requestId, msg.from, msg.to, msg.userId); return true;
      case "user_storage_stat": this.handleUserStorageStat(msg.requestId, msg.path, msg.userId); return true;
      case "enclave_put": void this.handleEnclavePut(msg.requestId, msg.key, msg.value, msg.userId); return true;
      case "enclave_get": void this.handleEnclaveGet(msg.requestId, msg.key, msg.userId); return true;
      case "enclave_delete": this.handleEnclaveDelete(msg.requestId, msg.key, msg.userId); return true;
      case "enclave_has": void this.handleEnclaveHas(msg.requestId, msg.key, msg.userId); return true;
      case "enclave_list": this.handleEnclaveList(msg.requestId, msg.userId); return true;
      case "ephemeral_read": this.handleEphemeralRead(msg.requestId, msg.path); return true;
      case "ephemeral_write": void this.handleEphemeralWrite(msg.requestId, msg.path, msg.data, msg.ttlMs, msg.reservationId); return true;
      case "ephemeral_read_binary": this.handleEphemeralReadBinary(msg.requestId, msg.path); return true;
      case "ephemeral_write_binary": void this.handleEphemeralWriteBinary(msg.requestId, msg.path, msg.data, msg.ttlMs, msg.reservationId); return true;
      case "ephemeral_delete": this.handleEphemeralDelete(msg.requestId, msg.path); return true;
      case "ephemeral_list": this.handleEphemeralList(msg.requestId, msg.prefix); return true;
      case "ephemeral_stat": this.handleEphemeralStat(msg.requestId, msg.path); return true;
      case "ephemeral_clear_expired": this.handleEphemeralClearExpired(msg.requestId); return true;
      case "ephemeral_pool_status": void this.handleEphemeralPoolStatus(msg.requestId); return true;
      case "ephemeral_request_block": void this.handleEphemeralRequestBlock(msg.requestId, msg.sizeBytes, msg.ttlMs, msg.reason); return true;
      case "ephemeral_release_block": this.handleEphemeralReleaseBlock(msg.requestId, msg.reservationId); return true;
      default: return false;
    }
  }

  private get identifier(): string {
    return this.options.identifier;
  }

  private respond(requestId: string, result: unknown): void {
    this.options.postResponse({ type: "response", requestId, result });
  }

  private fail(requestId: string, error: unknown): void {
    this.options.postResponse({
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private getStorageRootPath(identifier = this.identifier): string {
    if (identifier === this.identifier && this.options.installScope === "user") {
      if (!this.options.installedByUserId) throw new Error("Extension owner is not set");
      return managerSvc.getUserExtensionStoragePath(identifier, this.options.installedByUserId);
    }
    return managerSvc.getStoragePath(identifier);
  }

  private resolveStoragePath(requestedPath: string): string {
    return this.resolveWithin(this.getStorageRootPath(), requestedPath);
  }

  private resolveWithin(basePath: string, requestedPath: string): string {
    const base = resolve(basePath);
    const target = resolve(base, requestedPath);
    if (!(target === base || target.startsWith(`${base}${sep}`))) {
      throw new Error("Path traversal detected");
    }
    return target;
  }

  private listFiles(searchDir: string, hiddenFiles = new Set<string>()): string[] {
    if (!existsSync(searchDir)) return [];
    return readdirSync(searchDir, { recursive: true })
      .map((entry) => (typeof entry === "string" ? entry : entry.toString()))
      .filter((entry) => !hiddenFiles.has(entry))
      .filter((entry) => {
        try {
          return statSync(join(searchDir, entry)).isFile();
        } catch {
          return false;
        }
      });
  }

  private statResponse(requestId: string, path: string): void {
    if (!existsSync(path)) {
      this.respond(requestId, {
        exists: false,
        isFile: false,
        isDirectory: false,
        sizeBytes: 0,
        modifiedAt: new Date(0).toISOString(),
      });
      return;
    }
    const stat = statSync(path);
    this.respond(requestId, {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      sizeBytes: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    });
  }

  handleStorageRead(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (!existsSync(fullPath)) return this.fail(requestId, "File not found");
      this.respond(requestId, readFileSync(fullPath, "utf-8"));
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageWrite(requestId: string, path: string, data: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data, "utf-8");
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageReadBinary(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (!existsSync(fullPath)) return this.fail(requestId, "File not found");
      this.respond(requestId, new Uint8Array(readFileSync(fullPath)));
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageWriteBinary(requestId: string, path: string, data: Uint8Array): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data);
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageDelete(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (existsSync(fullPath)) {
        if (statSync(fullPath).isDirectory()) rmSync(fullPath, { recursive: true, force: true });
        else unlinkSync(fullPath);
      }
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageList(requestId: string, prefix?: string): void {
    try {
      this.respond(requestId, this.listFiles(prefix ? this.resolveStoragePath(prefix) : this.getStorageRootPath()));
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageExists(requestId: string, path: string): void {
    try { this.respond(requestId, existsSync(this.resolveStoragePath(path))); }
    catch (error) { this.fail(requestId, error); }
  }

  handleStorageMkdir(requestId: string, path: string): void {
    try { mkdirSync(this.resolveStoragePath(path), { recursive: true }); this.respond(requestId, true); }
    catch (error) { this.fail(requestId, error); }
  }

  handleStorageMove(requestId: string, from: string, to: string): void {
    try {
      const fromPath = this.resolveStoragePath(from);
      if (!existsSync(fromPath)) return this.fail(requestId, "File not found");
      const toPath = this.resolveStoragePath(to);
      mkdirSync(resolve(toPath, ".."), { recursive: true });
      renameSync(fromPath, toPath);
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleStorageStat(requestId: string, path: string): void {
    try { this.statResponse(requestId, this.resolveStoragePath(path)); }
    catch (error) { this.fail(requestId, error); }
  }

  private resolveUserId(requestUserId?: string): string {
    if (this.options.installScope === "user") {
      if (!this.options.installedByUserId) throw new Error("Extension owner is not set");
      return this.options.installedByUserId;
    }
    if (!requestUserId) throw new Error("userId is required for operator-scoped extensions");
    return requestUserId;
  }

  private resolveUserStoragePath(requestedPath: string, userId: string): string {
    const base = getUserExtensionPath(userId, this.identifier);
    mkdirSync(base, { recursive: true });
    return this.resolveWithin(base, requestedPath);
  }

  handleUserStorageRead(requestId: string, path: string, userId?: string): void {
    try {
      const fullPath = this.resolveUserStoragePath(path, this.resolveUserId(userId));
      if (!existsSync(fullPath)) return this.fail(requestId, "File not found");
      this.respond(requestId, readFileSync(fullPath, "utf-8"));
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageWrite(requestId: string, path: string, data: string, userId?: string): void {
    try {
      const fullPath = this.resolveUserStoragePath(path, this.resolveUserId(userId));
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data, "utf-8");
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageReadBinary(requestId: string, path: string, userId?: string): void {
    try {
      const fullPath = this.resolveUserStoragePath(path, this.resolveUserId(userId));
      if (!existsSync(fullPath)) return this.fail(requestId, "File not found");
      this.respond(requestId, new Uint8Array(readFileSync(fullPath)));
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageWriteBinary(requestId: string, path: string, data: Uint8Array, userId?: string): void {
    try {
      const fullPath = this.resolveUserStoragePath(path, this.resolveUserId(userId));
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data);
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageDelete(requestId: string, path: string, userId?: string): void {
    try {
      const fullPath = this.resolveUserStoragePath(path, this.resolveUserId(userId));
      if (existsSync(fullPath)) {
        if (statSync(fullPath).isDirectory()) rmSync(fullPath, { recursive: true, force: true });
        else unlinkSync(fullPath);
      }
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageList(requestId: string, prefix?: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserId(userId);
      const base = getUserExtensionPath(resolvedUserId, this.identifier);
      mkdirSync(base, { recursive: true });
      this.respond(requestId, this.listFiles(prefix ? this.resolveUserStoragePath(prefix, resolvedUserId) : base));
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageExists(requestId: string, path: string, userId?: string): void {
    try { this.respond(requestId, existsSync(this.resolveUserStoragePath(path, this.resolveUserId(userId)))); }
    catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageMkdir(requestId: string, path: string, userId?: string): void {
    try { mkdirSync(this.resolveUserStoragePath(path, this.resolveUserId(userId)), { recursive: true }); this.respond(requestId, true); }
    catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageMove(requestId: string, from: string, to: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserId(userId);
      const fromPath = this.resolveUserStoragePath(from, resolvedUserId);
      if (!existsSync(fromPath)) return this.fail(requestId, "File not found");
      const toPath = this.resolveUserStoragePath(to, resolvedUserId);
      mkdirSync(resolve(toPath, ".."), { recursive: true });
      renameSync(fromPath, toPath);
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleUserStorageStat(requestId: string, path: string, userId?: string): void {
    try { this.statResponse(requestId, this.resolveUserStoragePath(path, this.resolveUserId(userId))); }
    catch (error) { this.fail(requestId, error); }
  }

  private validateEnclaveKey(key: string): void {
    if (!ENCLAVE_KEY_PATTERN.test(key)) {
      throw new Error("Invalid enclave key: must be 1-128 characters, alphanumeric/underscore/dash/dot only");
    }
  }

  private validateEnclaveValue(value: string): void {
    if (typeof value !== "string") throw new Error("Enclave value must be a string");
    if (Buffer.byteLength(value, "utf-8") > ENCLAVE_MAX_VALUE_BYTES) throw new Error("Enclave value exceeds maximum size of 64KB");
    if (/[^\x20-\x7E\t\n\r]/.test(value)) throw new Error("Enclave value contains invalid characters (binary/control chars not allowed)");
  }

  private enclaveKey(key: string): string { return `spindle:${this.identifier}:${key}`; }

  async handleEnclavePut(requestId: string, key: string, value: string, userId?: string): Promise<void> {
    try {
      this.validateEnclaveKey(key); this.validateEnclaveValue(value);
      await putSecret(this.resolveUserId(userId), this.enclaveKey(key), value);
      this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  async handleEnclaveGet(requestId: string, key: string, userId?: string): Promise<void> {
    try { this.validateEnclaveKey(key); this.respond(requestId, await getSecret(this.resolveUserId(userId), this.enclaveKey(key))); }
    catch (error) { this.fail(requestId, error); }
  }

  handleEnclaveDelete(requestId: string, key: string, userId?: string): void {
    try { this.validateEnclaveKey(key); this.respond(requestId, deleteSecret(this.resolveUserId(userId), this.enclaveKey(key))); }
    catch (error) { this.fail(requestId, error); }
  }

  async handleEnclaveHas(requestId: string, key: string, userId?: string): Promise<void> {
    try { this.validateEnclaveKey(key); this.respond(requestId, await validateSecret(this.resolveUserId(userId), this.enclaveKey(key))); }
    catch (error) { this.fail(requestId, error); }
  }

  handleEnclaveList(requestId: string, userId?: string): void {
    try {
      const prefix = `spindle:${this.identifier}:`;
      this.respond(requestId, listSecretKeys(this.resolveUserId(userId)).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
    } catch (error) { this.fail(requestId, error); }
  }

  private getEphemeralBasePath(): string {
    if (!this.options.hasPermission("ephemeral_storage")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} ephemeral_storage — Ephemeral storage permission not granted`);
    }
    const base = resolve(this.getStorageRootPath(), ".ephemeral");
    mkdirSync(base, { recursive: true });
    return base;
  }

  private resolveEphemeralPath(requestedPath: string): string {
    return this.resolveWithin(this.getEphemeralBasePath(), requestedPath);
  }

  private getReservationsPath(identifier = this.identifier, storageRoot?: string): string {
    if (identifier === this.identifier && !storageRoot) this.getEphemeralBasePath();
    const base = resolve(storageRoot ?? this.getStorageRootPath(identifier), ".ephemeral");
    mkdirSync(base, { recursive: true });
    return join(base, ".reservations.json");
  }

  private readReservations(identifier = this.identifier, storageRoot?: string): Reservation[] {
    const path = this.getReservationsPath(identifier, storageRoot);
    if (!existsSync(path)) return [];
    try {
      const rows = JSON.parse(readFileSync(path, "utf-8"));
      return Array.isArray(rows) ? rows.filter((row): row is Reservation => Boolean(row) && typeof row.id === "string" && typeof row.sizeBytes === "number" && typeof row.consumedBytes === "number" && typeof row.createdAt === "string" && typeof row.expiresAt === "string") : [];
    } catch { return []; }
  }

  private writeReservations(rows: Reservation[], identifier = this.identifier, storageRoot?: string): void {
    writeFileSync(this.getReservationsPath(identifier, storageRoot), JSON.stringify(rows, null, 2), "utf-8");
  }

  private clearExpiredReservations(identifier = this.identifier): number {
    const current = this.readReservations(identifier);
    const now = Date.now();
    const next = current.filter((row) => {
      const expires = Date.parse(row.expiresAt);
      return !Number.isNaN(expires) && expires > now && row.consumedBytes < row.sizeBytes;
    });
    this.writeReservations(next, identifier);
    return current.length - next.length;
  }

  private getIndexPath(): string { return join(this.getEphemeralBasePath(), ".index.json"); }

  private readIndex(): Record<string, { createdAt: string; expiresAt?: string; sizeBytes: number }> {
    const path = this.getIndexPath();
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
  }

  private writeIndex(index: Record<string, { createdAt: string; expiresAt?: string; sizeBytes: number }>): void {
    writeFileSync(this.getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
  }

  private pathKey(fullPath: string): string { return relative(this.getEphemeralBasePath(), fullPath).replaceAll("\\", "/"); }

  private upsertIndex(pathKey: string, sizeBytes: number, ttlMs?: number): void {
    const index = this.readIndex();
    const now = new Date().toISOString();
    index[pathKey] = { createdAt: index[pathKey]?.createdAt ?? now, expiresAt: ttlMs && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : undefined, sizeBytes };
    this.writeIndex(index);
  }

  private removeIndex(pathKey: string): void { const index = this.readIndex(); delete index[pathKey]; this.writeIndex(index); }

  private usage(): { totalBytes: number; fileCount: number; files: Map<string, number>; reservedBytes: number; reservations: Map<string, Reservation> } {
    const base = this.getEphemeralBasePath();
    const indexPath = this.getIndexPath();
    const reservationsPath = this.getReservationsPath();
    const files = new Map<string, number>();
    if (existsSync(base)) {
      for (const entry of readdirSync(base, { recursive: true })) {
        const fullPath = join(base, typeof entry === "string" ? entry : entry.toString());
        if (fullPath === indexPath || fullPath === reservationsPath) continue;
        try { const stat = statSync(fullPath); if (stat.isFile()) files.set(this.pathKey(fullPath), stat.size); } catch { /* unreadable files do not count */ }
      }
    }
    const reservations = new Map<string, Reservation>();
    let reservedBytes = 0;
    for (const row of this.readReservations()) {
      const remaining = Math.max(0, row.sizeBytes - row.consumedBytes);
      if (remaining > 0) { reservations.set(row.id, row); reservedBytes += remaining; }
    }
    return { totalBytes: [...files.values()].reduce((total, size) => total + size, 0), fileCount: files.size, files, reservedBytes, reservations };
  }

  private usageForExtension(extension: ExtensionInfo): { usedBytes: number; reservedBytes: number } {
    const storageRoot = managerSvc.getStoragePathForExtension(extension);
    const base = resolve(storageRoot, ".ephemeral");
    const hidden = new Set([join(base, ".index.json"), join(base, ".reservations.json")]);
    let usedBytes = 0;
    if (existsSync(base)) for (const entry of readdirSync(base, { recursive: true })) {
      const fullPath = join(base, typeof entry === "string" ? entry : entry.toString());
      if (hidden.has(fullPath)) continue;
      try { const stat = statSync(fullPath); if (stat.isFile()) usedBytes += stat.size; } catch { /* ignore unreadable files */ }
    }
    const now = Date.now();
    const reservedBytes = this.readReservations(extension.identifier, storageRoot).reduce((total, row) => {
      const expires = Date.parse(row.expiresAt);
      return Number.isNaN(expires) || expires <= now ? total : total + Math.max(0, row.sizeBytes - row.consumedBytes);
    }, 0);
    return { usedBytes, reservedBytes };
  }

  private async globalUsage(): Promise<{ usedBytes: number; reservedBytes: number }> {
    let usedBytes = 0; let reservedBytes = 0;
    for (const extension of await managerSvc.list()) {
      const usage = this.usageForExtension(extension); usedBytes += usage.usedBytes; reservedBytes += usage.reservedBytes;
    }
    return { usedBytes, reservedBytes };
  }

  private clearExpiredEntries(): number {
    const base = this.getEphemeralBasePath();
    const index = this.readIndex();
    let removed = 0;
    for (const [pathKey, metadata] of Object.entries(index)) {
      const expiresAt = metadata.expiresAt ? Date.parse(metadata.expiresAt) : NaN;
      if (!metadata.expiresAt || Number.isNaN(expiresAt) || expiresAt > Date.now()) continue;
      const fullPath = this.resolveWithin(base, pathKey);
      if (existsSync(fullPath)) unlinkSync(fullPath);
      delete index[pathKey]; removed += 1;
    }
    this.writeIndex(index);
    return removed;
  }

  private async enforceQuota(pathKey: string, incomingSize: number, reservationId?: string): Promise<number> {
    this.clearExpiredEntries(); this.clearExpiredReservations();
    const current = this.usage();
    const global = await this.globalUsage();
    const config = await getEphemeralPoolConfig();
    const extensionMax = config.extensionMaxOverrides[this.identifier] ?? config.extensionDefaultMaxBytes;
    const existingSize = current.files.get(pathKey) ?? 0;
    const growth = Math.max(0, incomingSize - existingSize);
    const reservation = reservationId ? current.reservations.get(reservationId) : undefined;
    if (reservationId && !reservation) throw new Error(`Reservation not found: ${reservationId}`);
    const consumed = reservation ? Math.min(Math.max(0, reservation.sizeBytes - reservation.consumedBytes), growth) : 0;
    const nextTotal = current.totalBytes - existingSize + incomingSize;
    const nextCount = current.fileCount + (current.files.has(pathKey) ? 0 : 1);
    if (nextCount > EPHEMERAL_MAX_FILES) throw new Error(`Ephemeral storage file quota exceeded (${nextCount}/${EPHEMERAL_MAX_FILES})`);
    if (nextTotal + current.reservedBytes - consumed > extensionMax) throw new Error(`Ephemeral extension pool exceeded (${nextTotal + current.reservedBytes - consumed}/${extensionMax} bytes)`);
    const nextGlobal = global.usedBytes - existingSize + incomingSize;
    if (nextGlobal + global.reservedBytes - consumed > config.globalMaxBytes) throw new Error(`Ephemeral global pool exceeded (${nextGlobal + global.reservedBytes - consumed}/${config.globalMaxBytes} bytes)`);
    return consumed;
  }

  private consumeReservation(reservationId: string, size: number): void {
    if (size <= 0) return;
    this.writeReservations(this.readReservations().map((row) => row.id === reservationId ? { ...row, consumedBytes: Math.min(row.sizeBytes, row.consumedBytes + size) } : row).filter((row) => row.consumedBytes < row.sizeBytes));
  }

  handleEphemeralRead(requestId: string, path: string): void {
    try { const fullPath = this.resolveEphemeralPath(path); if (!existsSync(fullPath)) return this.fail(requestId, "File not found"); this.respond(requestId, readFileSync(fullPath, "utf-8")); }
    catch (error) { this.fail(requestId, error); }
  }

  async handleEphemeralWrite(requestId: string, path: string, data: string, ttlMs?: number, reservationId?: string): Promise<void> {
    try {
      const fullPath = this.resolveEphemeralPath(path); const pathKey = this.pathKey(fullPath);
      const consumed = await this.enforceQuota(pathKey, Buffer.byteLength(data, "utf-8"), reservationId);
      mkdirSync(resolve(fullPath, ".."), { recursive: true }); writeFileSync(fullPath, data, "utf-8"); this.upsertIndex(pathKey, Buffer.byteLength(data, "utf-8"), ttlMs);
      if (reservationId) this.consumeReservation(reservationId, consumed); this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralReadBinary(requestId: string, path: string): void {
    try { const fullPath = this.resolveEphemeralPath(path); if (!existsSync(fullPath)) return this.fail(requestId, "File not found"); this.respond(requestId, new Uint8Array(readFileSync(fullPath))); }
    catch (error) { this.fail(requestId, error); }
  }

  async handleEphemeralWriteBinary(requestId: string, path: string, data: Uint8Array, ttlMs?: number, reservationId?: string): Promise<void> {
    try {
      const fullPath = this.resolveEphemeralPath(path); const pathKey = this.pathKey(fullPath);
      const consumed = await this.enforceQuota(pathKey, data.byteLength, reservationId);
      mkdirSync(resolve(fullPath, ".."), { recursive: true }); writeFileSync(fullPath, data); this.upsertIndex(pathKey, data.byteLength, ttlMs);
      if (reservationId) this.consumeReservation(reservationId, consumed); this.respond(requestId, true);
    } catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralDelete(requestId: string, path: string): void {
    try { const fullPath = this.resolveEphemeralPath(path); if (existsSync(fullPath)) unlinkSync(fullPath); this.removeIndex(this.pathKey(fullPath)); this.respond(requestId, true); }
    catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralList(requestId: string, prefix?: string): void {
    try { this.respond(requestId, this.listFiles(prefix ? this.resolveEphemeralPath(prefix) : this.getEphemeralBasePath(), new Set([".index.json", ".reservations.json"]))); }
    catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralStat(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveEphemeralPath(path); if (!existsSync(fullPath)) return this.fail(requestId, "File not found");
      const stat = statSync(fullPath); const metadata = this.readIndex()[this.pathKey(fullPath)];
      this.respond(requestId, { sizeBytes: metadata?.sizeBytes ?? stat.size, createdAt: metadata?.createdAt ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(), expiresAt: metadata?.expiresAt });
    } catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralClearExpired(requestId: string): void {
    try { this.respond(requestId, this.clearExpiredEntries() + this.clearExpiredReservations()); }
    catch (error) { this.fail(requestId, error); }
  }

  async handleEphemeralPoolStatus(requestId: string): Promise<void> {
    try {
      this.clearExpiredEntries(); this.clearExpiredReservations();
      const extension = this.usage(); const global = await this.globalUsage(); const config = await getEphemeralPoolConfig();
      const extensionMax = config.extensionMaxOverrides[this.identifier] ?? config.extensionDefaultMaxBytes;
      this.respond(requestId, { globalMaxBytes: config.globalMaxBytes, globalUsedBytes: global.usedBytes, globalReservedBytes: global.reservedBytes, globalAvailableBytes: Math.max(0, config.globalMaxBytes - global.usedBytes - global.reservedBytes), extensionMaxBytes: extensionMax, extensionUsedBytes: extension.totalBytes, extensionReservedBytes: extension.reservedBytes, extensionAvailableBytes: Math.max(0, extensionMax - extension.totalBytes - extension.reservedBytes), fileCount: extension.fileCount, fileCountMax: EPHEMERAL_MAX_FILES });
    } catch (error) { this.fail(requestId, error); }
  }

  async handleEphemeralRequestBlock(requestId: string, sizeBytes: number, ttlMs?: number, reason?: string): Promise<void> {
    try {
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error("sizeBytes must be a positive number");
      this.clearExpiredEntries(); this.clearExpiredReservations();
      const extension = this.usage(); const global = await this.globalUsage(); const config = await getEphemeralPoolConfig();
      const extensionMax = config.extensionMaxOverrides[this.identifier] ?? config.extensionDefaultMaxBytes;
      const extensionAvailable = extensionMax - extension.totalBytes - extension.reservedBytes;
      const globalAvailable = config.globalMaxBytes - global.usedBytes - global.reservedBytes;
      if (sizeBytes > extensionAvailable) throw new Error(`Requested block exceeds extension available pool (${sizeBytes}/${Math.max(0, extensionAvailable)} bytes)`);
      if (sizeBytes > globalAvailable) throw new Error(`Requested block exceeds global available pool (${sizeBytes}/${Math.max(0, globalAvailable)} bytes)`);
      const expiresAt = new Date(Date.now() + (ttlMs && ttlMs > 0 ? ttlMs : config.reservationTtlMs)).toISOString();
      const reservationId = crypto.randomUUID();
      this.writeReservations([...this.readReservations(), { id: reservationId, sizeBytes, consumedBytes: 0, createdAt: new Date().toISOString(), expiresAt, reason }]);
      this.respond(requestId, { reservationId, sizeBytes, expiresAt });
    } catch (error) { this.fail(requestId, error); }
  }

  handleEphemeralReleaseBlock(requestId: string, reservationId: string): void {
    try { this.writeReservations(this.readReservations().filter((row) => row.id !== reservationId)); this.respond(requestId, true); }
    catch (error) { this.fail(requestId, error); }
  }
}
