import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SQLQueryBindings } from "bun:sqlite";
import {
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { open, rm, mkdir, chmod, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, basename } from "node:path";
import { getDatabasePath, getDb } from "../../db/connection";
import {
  ARCHIVE_CANONICAL_TABLES,
  buildArchiveOwnerPredicate,
  type ArchiveFileBucket,
  type ArchiveFileRefV2,
} from "./table-registry";
import { strictestMediaLimit } from "../../types/media-limits";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ROWS_PER_TABLE,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_ARCHIVE_TOTAL_ROWS,
  NDJSON_MAX_RECORD_BYTES,
} from "./manifest";
import { env } from "../../env";

/** Maximum bytes read by one frozen descriptor unless a test explicitly lowers it. */
export const MAX_FROZEN_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const FROZEN_FILE_HASH_ALGORITHM = "sha256" as const;

export type ArchiveFileKind =
  | "image"
  | "image_variant"
  | "thumbnail"
  | "avatar"
  | "audio"
  | "databank_document"
  | "theme_asset"
  | "notification_sound";

export interface FileIdentityV1 {
  /** Device and inode identify the source object rather than its pathname. */
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly mode: number;
}

export interface FrozenFileDescriptorV1 {
  readonly kind: ArchiveFileKind;
  readonly ownerTable: string;
  readonly ownerKey: string;
  readonly owner: Readonly<{ table: string; key: string }>;
  readonly path: string;
  readonly required: boolean;
  readonly sourceRoot: string;
  readonly sourceIdentity: FileIdentityV1;
  readonly bytes: number;
  readonly sha256: string;
  readonly archivePath?: string;
}

export interface FreezeFileInput {
  readonly kind: ArchiveFileKind;
  readonly ownerTable: string;
  readonly ownerKey: string;
  readonly path: string;
  readonly required?: boolean;
  readonly allowedRoot?: string;
  readonly archivePath?: string;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface StageFrozenFileOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface StagedFrozenFileV1 {
  readonly descriptor: FrozenFileDescriptorV1;
  readonly path: string;
  readonly stagedPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceIdentity: FileIdentityV1;
}

export interface UserDataProjectionStampV1 {
  /** Canonical source epoch advanced by every user-data mutation. */
  readonly sourceEpoch: number;
  /** Source epoch/digest most recently covered by a successful projection. */
  readonly projectedSourceEpoch: number | null;
  readonly projectedSourceDigest: string | null;
  /** Process-wide fence retained so bounded user stamps cannot reset safely. */
  readonly globalEpoch: number;
}

export interface ProjectionCoverageOptionsV1 {
  readonly signal?: AbortSignal;
  /** Recompute the canonical source digest under the held barrier. */
  readonly verifySourceDigest?: () => string | Promise<string>;
  /** Prove the derived store now projects every source row for this user. */
  readonly isProjectionComplete?: () => boolean | Promise<boolean>;
}

export interface UserDataReadSnapshot {
  readonly db: Database;
  readonly snapshotId: string;
  readonly files: readonly FrozenFileDescriptorV1[];
  readonly sourceDigest: string;
  readonly projection: UserDataProjectionStampV1;
  close(): void;
}

type MutationCallback<T> = (signal: AbortSignal) => T | Promise<T>;
type QueueKind = "mutation" | "projection" | "exclusive";
interface Waiter<T> {
  readonly kind: QueueKind;
  readonly userId: string;
  readonly callback: MutationCallback<T>;
  readonly signal?: AbortSignal;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  settled: boolean;
  abortListener?: () => void;
}

interface BarrierState {
  activeMutations: number;
  activeExclusive: boolean;
  queue: Waiter<unknown>[];
}

/**
 * A fair per-user barrier. Mutations share the read side of the barrier with
 * one another; an export/reconciliation callback takes the exclusive side.
 * Once an exclusive waiter is queued, later mutations wait behind it. The
 * AsyncLocalStorage context permits a writer to compose lower-level writers
 * without deadlocking itself while retaining fairness for unrelated work.
 */
export class UserDataSnapshotBarrier {
  private readonly states = new Map<string, BarrierState>();
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly sourceEpochs = new Map<string, number>();
  private readonly projectionCoverage = new Map<string, { sourceEpoch: number; sourceDigest: string }>();
  private globalProjectionEpoch = 0;
  private static readonly MAX_PROJECTION_EPOCH_USERS = 4096;

  withMutation<T>(userId: string, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) {
      throwIfAborted(signal);
      return Promise.resolve().then(() => callback(signal ?? neverAbortedSignal));
    }
    return this.enqueue(userId, "mutation", callback, signal);
  }

  getProjectionStamp(userId: string): UserDataProjectionStampV1 {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const coverage = this.projectionCoverage.get(userId);
    return Object.freeze({
      sourceEpoch: this.sourceEpochs.get(userId) ?? 0,
      projectedSourceEpoch: coverage?.sourceEpoch ?? null,
      projectedSourceDigest: coverage?.sourceDigest ?? null,
      globalEpoch: this.globalProjectionEpoch,
    });
  }

  /**
   * Run one complete derived-store projection for a user and publish coverage
   * exactly once, after the whole operation succeeded, while the barrier is
   * still held and the canonical source is provably unchanged. A concurrent
   * source edit is not an error for the projecting caller; it only withholds
   * coverage so a later export reports `rebuild_required` instead of claiming
   * a stable dump.
   */
  withProjection<T>(
    userId: string,
    sourceEpoch: number,
    sourceDigest: string,
    callback: MutationCallback<T>,
    options?: ProjectionCoverageOptionsV1,
  ): Promise<T> {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) throw new RangeError("sourceEpoch must be a non-negative safe integer");
    if (!/^[0-9a-f]{64}$/u.test(sourceDigest)) throw new TypeError("sourceDigest must be a SHA-256 digest");
    const signal = options?.signal;
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) {
      // An enclosing barrier holder owns the coverage decision for this user.
      throwIfAborted(signal);
      return Promise.resolve().then(() => callback(signal ?? neverAbortedSignal));
    }
    return this.enqueue(userId, "projection", async (projectionSignal) => {
      const result = await callback(projectionSignal);
      if ((this.sourceEpochs.get(userId) ?? 0) !== sourceEpoch) return result;
      if (options?.verifySourceDigest && (await options.verifySourceDigest()) !== sourceDigest) return result;
      if (options?.isProjectionComplete && !(await options.isProjectionComplete())) return result;
      this.projectionCoverage.set(userId, { sourceEpoch, sourceDigest });
      return result;
    }, signal);
  }

  /**
   * Serialize a derived-store mutation with snapshots without advancing the
   * canonical source epoch or publishing projection coverage. Callers that
   * perform a complete projection use withProjection around the whole batch;
   * individual writes must not make a partial batch look exportable.
   */
  withProjectionMutation<T>(userId: string, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) {
      throwIfAborted(signal);
      return Promise.resolve().then(() => callback(signal ?? neverAbortedSignal));
    }
    return this.enqueue(userId, "projection", callback, signal);
  }

  withExclusive<T>(userId: string, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) {
      throw new Error("Cannot acquire an exclusive user-data barrier from inside a mutation");
    }
    return this.enqueue(userId, "exclusive", callback, signal);
  }

  /** Synchronous compatibility path for legacy synchronous delete APIs. */
  withMutationSync<T>(userId: string, callback: () => T): T {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) return callback();
    const state = this.stateFor(userId);
    if (state.activeExclusive || state.queue.length > 0) {
      throw new UserDataBarrierBusyError(userId);
    }
    state.activeMutations += 1;
    this.advanceSourceEpoch(userId);
    try {
      const next = new Set(inherited);
      next.add(userId);
      return this.context.run(next, callback);
    } finally {
      state.activeMutations -= 1;
      this.cleanupState(userId, state);
    }
  }
  /** Synchronous startup/recovery path for an exclusive account operation. */
  withExclusiveSync<T>(userId: string, callback: () => T): T {
    if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
    const inherited = this.context.getStore();
    if (inherited?.has(userId)) throw new Error("Cannot acquire an exclusive user-data barrier from inside a mutation");
    const state = this.stateFor(userId);
    if (state.activeExclusive || state.activeMutations > 0 || state.queue.length > 0) {
      throw new UserDataBarrierBusyError(userId);
    }
    state.activeExclusive = true;
    try {
      const next = new Set(inherited);
      next.add(userId);
      return this.context.run(next, callback);
    } finally {
      state.activeExclusive = false;
      this.cleanupState(userId, state);
      this.drain(userId, state);
    }
  }


  /** Visible for focused tests and diagnostics; does not expose callbacks. */
  getState(userId: string): Readonly<{ activeMutations: number; activeExclusive: boolean; queued: number }> {
    const state = this.states.get(userId);
    return {
      activeMutations: state?.activeMutations ?? 0,
      activeExclusive: state?.activeExclusive ?? false,
      queued: state?.queue.length ?? 0,
    };
  }

  private enqueue<T>(userId: string, kind: QueueKind, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const state = this.stateFor(userId);
    return new Promise<T>((resolvePromise, reject) => {
      const waiter: Waiter<T> = {
        kind,
        userId,
        callback,
        signal,
        resolve: resolvePromise,
        reject,
        settled: false,
      };
      if (signal) {
        const abort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = state.queue.indexOf(waiter as Waiter<unknown>);
          if (index >= 0) state.queue.splice(index, 1);
          reject(signal.reason ?? abortError());
          this.cleanupState(userId, state);
          this.drain(userId, state);
        };
        waiter.abortListener = abort;
        signal.addEventListener("abort", abort, { once: true });
      }
      state.queue.push(waiter as Waiter<unknown>);
      this.drain(userId, state);
    });
  }

  private drain(userId: string, state: BarrierState): void {
    if (state.activeExclusive) return;
    const first = state.queue[0];
    if (!first) {
      this.cleanupState(userId, state);
      return;
    }
    if (first.kind === "exclusive") {
      if (state.activeMutations > 0) return;
      state.queue.shift();
      if (first.settled) return this.drain(userId, state);
      state.activeExclusive = true;
      void this.startWaiter(first).then(
        (result) => {
          state.activeExclusive = false;
          this.cleanupState(userId, state);
          this.drain(userId, state);
          first.resolve(result);
        },
        (error: unknown) => {
          state.activeExclusive = false;
          this.cleanupState(userId, state);
          this.drain(userId, state);
          first.reject(error);
        },
      );
      return;
    }

    // Start all contiguous mutation waiters. An exclusive waiter is a strict
    // FIFO fence: it prevents any later mutation from starting early.
    while (!state.activeExclusive && (state.queue[0]?.kind === "mutation" || state.queue[0]?.kind === "projection")) {
      const waiter = state.queue.shift()!;
      if (waiter.settled) continue;
      state.activeMutations += 1;
      void this.startWaiter(waiter).then(
        (result) => {
          state.activeMutations -= 1;
          this.cleanupState(userId, state);
          this.drain(userId, state);
          waiter.resolve(result);
        },
        (error: unknown) => {
          state.activeMutations -= 1;
          this.cleanupState(userId, state);
          this.drain(userId, state);
          waiter.reject(error);
        },
      );
    }
  }

  private async startWaiter<T>(waiter: Waiter<T>): Promise<T> {
    waiter.settled = true;
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
    const parent = this.context.getStore();
    const store = new Set(parent);
    store.add(waiter.userId);
    const signal = waiter.signal ?? neverAbortedSignal;
    throwIfAborted(signal);
    if (waiter.kind === "mutation") this.advanceSourceEpoch(waiter.userId);
    return this.context.run(store, () => waiter.callback(signal));
  }

  private advanceSourceEpoch(userId: string): void {
    this.globalProjectionEpoch += 1;
    const next = (this.sourceEpochs.get(userId) ?? 0) + 1;
    this.sourceEpochs.set(userId, next);
    if (this.sourceEpochs.size > UserDataSnapshotBarrier.MAX_PROJECTION_EPOCH_USERS) {
      const oldest = this.sourceEpochs.keys().next().value;
      if (typeof oldest === "string" && oldest !== userId) {
        this.sourceEpochs.delete(oldest);
        this.projectionCoverage.delete(oldest);
      }
    }
  }

  private stateFor(userId: string): BarrierState {
    let state = this.states.get(userId);
    if (!state) {
      state = { activeMutations: 0, activeExclusive: false, queue: [] };
      this.states.set(userId, state);
    }
    return state;
  }

  private cleanupState(userId: string, state: BarrierState): void {
    if (state.activeMutations === 0 && !state.activeExclusive && state.queue.length === 0) this.states.delete(userId);
  }
}

export class UserDataBarrierBusyError extends Error {
  readonly code = "user_data_barrier_busy" as const;
  constructor(readonly userId: string) {
    super("User data is being exported; retry the mutation after the export completes");
    this.name = "UserDataBarrierBusyError";
  }
}

export const userDataSnapshotBarrier = new UserDataSnapshotBarrier();

export function withUserDataMutation<T>(userId: string, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
  return userDataSnapshotBarrier.withMutation(userId, callback, signal);
}
export function withUserDataMutationSync<T>(userId: string, callback: () => T): T {
  return userDataSnapshotBarrier.withMutationSync(userId, callback);
}
export function withUserDataExportSync<T>(userId: string, callback: () => T): T {
  return userDataSnapshotBarrier.withExclusiveSync(userId, callback);
}
export function withUserDataProjection<T>(
  userId: string,
  sourceEpoch: number,
  sourceDigest: string,
  callback: MutationCallback<T>,
  options?: ProjectionCoverageOptionsV1,
): Promise<T> {
  return userDataSnapshotBarrier.withProjection(userId, sourceEpoch, sourceDigest, callback, options);
}

export function withUserDataProjectionMutation<T>(
  userId: string,
  callback: MutationCallback<T>,
  signal?: AbortSignal,
): Promise<T> {
  return userDataSnapshotBarrier.withProjectionMutation(userId, callback, signal);
}

export function getUserDataProjectionStamp(userId: string): UserDataProjectionStampV1 {
  return userDataSnapshotBarrier.getProjectionStamp(userId);
}

export function withUserDataExport<T>(userId: string, callback: MutationCallback<T>, signal?: AbortSignal): Promise<T> {
  return userDataSnapshotBarrier.withExclusive(userId, callback, signal);
}

const neverAbortedController = new AbortController();
const neverAbortedSignal = neverAbortedController.signal;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

function pathWithin(base: string, candidate: string): boolean {
  const relativePath = relative(resolve(base), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.includes(`..${sep}`));
}

function rejectPathTraversal(filepath: string): void {
  if (filepath.split(/[\\/]+/u).some((segment) => segment === "..")) {
    throw new Error(`Archive source path traversal is not allowed: ${filepath}`);
  }
}

function resolveSymlinkPath(filepath: string, depth = 0): string {
  if (depth > 64) throw new Error(`Archive source path contains too many symlink hops: ${filepath}`);
  const absolute = resolve(filepath);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (let index = 0; index < parts.length; index++) {
    const candidate = join(current, parts[index]!);
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch {
      return join(current, ...parts.slice(index));
    }
    if (stats.isSymbolicLink()) {
      const target = String(readlinkSync(candidate));
      const rest = parts.slice(index + 1).join(sep);
      const expanded = rest.length > 0 ? join(resolve(dirname(candidate), target), rest) : resolve(dirname(candidate), target);
      return resolveSymlinkPath(expanded, depth + 1);
    }
    current = candidate;
  }
  return current;
}

function realpathWithMissingTail(filepath: string): string {
  try {
    return realpathSync(resolve(filepath));
  } catch {
    return resolveSymlinkPath(filepath);
  }
}

/** Validate lexical and realpath containment before any archive file is opened. */
export function resolveArchivePathWithinRoot(sourcePath: string, allowedRoot: string): string {
  if (typeof sourcePath !== "string" || typeof allowedRoot !== "string") {
    throw new TypeError("Archive source path and allowed root are required");
  }
  rejectPathTraversal(sourcePath);
  const candidate = resolve(sourcePath);
  const lexicalRoot = resolve(allowedRoot);
  if (!pathWithin(lexicalRoot, candidate)) {
    throw new Error(`Archive source path is outside its allowed root: ${candidate}`);
  }
  const realRoot = realpathWithMissingTail(lexicalRoot);
  const realCandidate = realpathWithMissingTail(candidate);
  if (!pathWithin(realRoot, realCandidate)) {
    throw new Error(`Archive source path resolves outside its allowed root: ${candidate}`);
  }
  return candidate;
}

export interface ArchiveSourcePathResolutionV1 {
  readonly path: string;
  readonly allowedRoot: string;
}

function safeArchivePathSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === ".." || /[\\/\\0]/u.test(value)) {
    throw new Error(`Invalid archive ${label}`);
  }
  return value;
}

function archiveOwnerSegment(row: Record<string, unknown>, userId: string): string {
  const owner = row.user_id === undefined || row.user_id === null ? userId : String(row.user_id);
  if (owner !== userId) throw new Error("Archive file owner does not match the authenticated user");
  return safeArchivePathSegment(owner, "file owner");
}

function archiveAllowedRoot(
  bucket: ArchiveFileBucket,
  row: Record<string, unknown>,
  dataDir: string,
  userId: string,
): string {
  const root = resolve(dataDir);
  switch (bucket) {
    case "images":
    case "thumbnails":
      return join(root, "images");
    case "avatars":
      return join(root, "avatars");
    case "audio":
      return join(root, "audio");
    case "databank":
      return join(root, "databank", archiveOwnerSegment(row, userId));
    case "theme-assets":
      return join(root, "theme-assets", archiveOwnerSegment(row, userId), safeArchivePathSegment(row.bundle_id, "theme bundle"));
    case "artifacts":
      return join(root, "agent-artifacts", archiveOwnerSegment(row, userId));
    default:
      throw new Error(`Unsupported archive file bucket: ${String(bucket)}`);
  }
}

export function resolveArchiveSourcePath(input: {
  readonly sourcePath: string;
  readonly bucket: ArchiveFileBucket;
  readonly row: Record<string, unknown>;
  readonly dataDir: string;
  readonly userId: string;
}): ArchiveSourcePathResolutionV1 {
  const allowedRoot = resolve(archiveAllowedRoot(input.bucket, input.row, input.dataDir, input.userId));
  return Object.freeze({
    path: resolveArchivePathWithinRoot(input.sourcePath, allowedRoot),
    allowedRoot,
  });
}

function identityFromStats(stats: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number; mode: number }): FileIdentityV1 {
  return Object.freeze({
    device: Number(stats.dev),
    inode: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    birthtimeMs: Number(stats.birthtimeMs),
    mode: Number(stats.mode),
  });
}

function sameIdentity(a: FileIdentityV1, b: FileIdentityV1): boolean {
  return a.device === b.device
    && a.inode === b.inode
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.birthtimeMs === b.birthtimeMs
    && a.mode === b.mode;
}

/** Compare frozen source identities without exposing the internal stat helper. */
export function fileIdentityEquals(a: FileIdentityV1, b: FileIdentityV1): boolean {
  return sameIdentity(a, b);
}

function validateRegularPath(filepath: string, allowedRoot?: string): string {
  const absolute = allowedRoot
    ? resolveArchivePathWithinRoot(filepath, allowedRoot)
    : resolve(filepath);
  const stats = lstatSync(absolute);
  if (!stats.isFile()) throw new Error(`Archive file is not a regular file: ${absolute}`);
  return absolute;
}

/**
 * Freeze one source file by descriptor identity and content digest.
 *
 * Hashing is deliberately asynchronous. A large media file must not monopolize
 * Bun's event loop while an export holds the account snapshot barrier.
 */
export async function freezeFileDescriptor(input: FreezeFileInput): Promise<FrozenFileDescriptorV1> {
  const maxBytes = input.maxBytes ?? MAX_FROZEN_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  throwIfAborted(input.signal);
  const requestedPath = resolve(input.path);
  const sourceRoot = resolve(input.allowedRoot ?? dirname(requestedPath));
  const filepath = validateRegularPath(input.path, sourceRoot);
  const expected = identityFromStats(lstatSync(filepath));
  if (expected.size > maxBytes) throw new Error(`Archive file exceeds the frozen-file limit: ${filepath}`);
  const source = await open(filepath, "r");
  try {
    const opened = identityFromStats(await source.stat());
    resolveArchivePathWithinRoot(filepath, sourceRoot);
    if (!sameIdentity(opened, expected)) throw new Error(`Archive file was replaced before hashing: ${filepath}`);
    const digest = await readAndHashFile(source, filepath, expected, maxBytes, input.signal, undefined, sourceRoot);
    const descriptor: FrozenFileDescriptorV1 = {
      kind: input.kind,
      ownerTable: input.ownerTable,
      ownerKey: input.ownerKey,
      owner: Object.freeze({ table: input.ownerTable, key: input.ownerKey }),
      path: filepath,
      required: input.required ?? false,
      sourceRoot,
      sourceIdentity: expected,
      bytes: digest.bytes,
      sha256: digest.sha256,
      ...(input.archivePath ? { archivePath: input.archivePath } : {}),
    };
    return Object.freeze(descriptor);
  } finally {
    await source.close().catch(() => {});
  }
}

async function readAndHashFile(
  handle: FileHandle,
  filepath: string,
  expected: FileIdentityV1,
  maxBytes: number,
  signal?: AbortSignal,
  destination?: FileHandle,
  allowedRoot?: string,
): Promise<{ bytes: number; sha256: string; final: FileIdentityV1 }> {
  const hash = createHash(FROZEN_FILE_HASH_ALGORITHM);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
    if (bytes > maxBytes) throw new Error(`Archive file exceeds the frozen-file limit: ${filepath}`);
    const chunk = buffer.subarray(0, result.bytesRead);
    hash.update(chunk);
    if (destination) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await destination.write(chunk, offset, chunk.byteLength - offset, null);
        if (written.bytesWritten <= 0) throw new Error(`Unable to stage archive file: ${filepath}`);
        offset += written.bytesWritten;
      }
    }
  }
  const final = identityFromStats(await handle.stat());
  if (allowedRoot) resolveArchivePathWithinRoot(filepath, allowedRoot);
  const pathIdentity = identityFromStats(lstatSync(filepath));
  if (!sameIdentity(final, expected) || !sameIdentity(pathIdentity, expected)) {
    throw new Error(`Archive file changed while it was being staged: ${filepath}`);
  }
  return { bytes, sha256: hash.digest("hex"), final };
}

/**
 * Copy a frozen descriptor through a read-open file descriptor into a
 * job/export-owned immutable staging file. The temporary path is never
 * exposed as a descriptor and is atomically renamed only after verification.
 */
export async function stageFrozenFile(
  descriptor: FrozenFileDescriptorV1,
  stagingDir: string,
  optionsOrSignal?: StageFrozenFileOptions | AbortSignal,
): Promise<StagedFrozenFileV1> {
  const options = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : optionsOrSignal;
  const maxBytes = options?.maxBytes ?? MAX_FROZEN_FILE_BYTES;
  throwIfAborted(options?.signal);
  const sourceRoot = descriptor.sourceRoot || dirname(descriptor.path);
  resolveArchivePathWithinRoot(descriptor.path, sourceRoot);
  const source = await open(descriptor.path, "r");
  const stageRoot = resolve(stagingDir);
  await mkdir(stageRoot, { recursive: true });
  const target = join(stageRoot, `${randomUUID()}-${basename(descriptor.path)}`);
  const temporary = `${target}.partial`;
  let destination: FileHandle | undefined;
  try {
    const opened = identityFromStats(await source.stat());
    resolveArchivePathWithinRoot(descriptor.path, sourceRoot);
    if (!sameIdentity(opened, descriptor.sourceIdentity)) {
      throw new Error(`Archive file was replaced before staging: ${descriptor.path}`);
    }
    destination = await open(temporary, "wx", 0o600);
    const result = await readAndHashFile(
      source,
      descriptor.path,
      descriptor.sourceIdentity,
      maxBytes,
      options?.signal,
      destination,
      sourceRoot,
    );
    await destination.close();
    destination = undefined;
    if (result.bytes !== descriptor.bytes || result.sha256 !== descriptor.sha256) {
      throw new Error(`Archive file digest changed while staging: ${descriptor.path}`);
    }
    await chmod(temporary, 0o444);
    await rename(temporary, target);
    return Object.freeze({
      descriptor,
      path: target,

      stagedPath: target,
      bytes: result.bytes,
      sha256: result.sha256,
      sourceIdentity: result.final,
    });
  } catch (error) {
    if (destination) await destination.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    await rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    await source.close().catch(() => {});
  }
}

export async function stageFrozenFiles(
  descriptors: readonly FrozenFileDescriptorV1[],
  stagingDir: string,
  options?: StageFrozenFileOptions,
): Promise<readonly StagedFrozenFileV1[]> {
  const staged: StagedFrozenFileV1[] = [];
  try {
    for (const descriptor of descriptors) staged.push(await stageFrozenFile(descriptor, stagingDir, options));
    return Object.freeze(staged);
  } catch (error) {
    await cleanupFrozenStaging(stagingDir);
    throw error;
  }
}

export async function cleanupFrozenStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}
function tableExists(db: Database, table: string): boolean {
  try {
    return !!db.query("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1").get(table);
  } catch {
    return false;
  }
}

function safeRows<T extends Record<string, unknown>>(db: Database, sql: string, params: readonly SQLQueryBindings[] = []): T[] {
  try {
    return db.query(sql).all(...params) as T[];
  } catch (error) {
    if (/no such (table|column)/i.test(String((error as Error)?.message ?? error))) return [];
    throw error;
  }
}

const VECTOR_REBUILD_SOURCE_TABLES = new Set([
  "chats",
  "messages",
  "databank_documents",
  "memory_consolidations",
  "world_book_entries",
]);

function sortedSourceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedSourceJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${sortedSourceJson(child)}`)
    .join(",")}}`;
}

/**
 * Hash vector-relevant owner rows from one already-open SQLite snapshot.
 * This byte encoding is shared with archive import's vector proof: table name
 * lines are sorted, owner IDs are normalized, and each row uses sorted JSON.
 */
export function computeUserDataSourceDigest(db: Database, userId: string): string {
  if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
  const hash = createHash(FROZEN_FILE_HASH_ALGORITHM);
  let totalRows = 0;
  let totalBytes = 0;
  const specs = ARCHIVE_CANONICAL_TABLES
    .filter((spec) => spec.lancedb || VECTOR_REBUILD_SOURCE_TABLES.has(spec.table))
    .slice()
    .sort((left, right) => left.table.localeCompare(right.table));
  for (const spec of specs) {
    if (!tableExists(db, spec.table)) continue;
    const owner = buildArchiveOwnerPredicate(spec, userId, "archive_row");
    const where = owner
      ? ` WHERE ${owner.sql}${spec.extraWhere ? ` AND (${spec.extraWhere})` : ""}`
      : spec.extraWhere
        ? ` WHERE ${spec.extraWhere}`
        : "";
    const orderColumns = spec.primaryKey.length > 0 ? spec.primaryKey : ["rowid"];
    const orderBy = orderColumns.map((column) => `archive_row."${column.replace(/"/gu, "\"\"")}"`).join(", ");
    const sql = `SELECT * FROM "${spec.table}" AS archive_row${where} ORDER BY ${orderBy}`;
    let tableRows = 0;
    let wroteTable = false;
    for (const sourceRow of db.query(sql).iterate(...(owner?.params ?? [])) as Iterable<Record<string, unknown>>) {
      if (!wroteTable) {
        hash.update(`${spec.table}\n`, "utf8");
        wroteTable = true;
      }
      tableRows += 1;
      totalRows += 1;
      if (tableRows > MAX_ARCHIVE_ROWS_PER_TABLE || totalRows > MAX_ARCHIVE_TOTAL_ROWS) {
        throw new Error("canonical source digest exceeds archive row limits");
      }
      const row = { ...sourceRow };
      if (Object.hasOwn(row, "user_id")) row.user_id = "<archive-owner>";
      const line = `${sortedSourceJson(row)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > NDJSON_MAX_RECORD_BYTES || totalBytes > MAX_ARCHIVE_TOTAL_BYTES - lineBytes) {
        throw new Error("canonical source digest exceeds archive byte limits");
      }
      hash.update(line, "utf8");
      totalBytes += lineBytes;
    }
  }
  return hash.digest("hex");
}

/**
 * Canonical rows whose vector projection is still outstanding. A derived-store
 * dump may only claim coverage when none of these remain: otherwise the vector
 * archive would advertise a complete projection of a source it never embedded.
 */
const PENDING_VECTOR_PROJECTION_SOURCES: ReadonlyArray<{ readonly table: string; readonly pending: string }> = [
  { table: "chat_chunks", pending: "archive_row.vectorized_at IS NULL" },
  { table: "databank_chunks", pending: "archive_row.vectorized_at IS NULL" },
  { table: "memory_consolidations", pending: "archive_row.vectorized_at IS NULL" },
  { table: "world_book_entries", pending: "archive_row.vectorized = 1 AND archive_row.vector_index_status <> 'indexed'" },
];

/**
 * True when any vector-relevant canonical row still awaits embedding. Errors
 * are reported as pending so an unreadable source can never be mistaken for a
 * completely projected one.
 */
export function hasPendingUserVectorProjection(db: Database, userId: string): boolean {
  if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
  for (const source of PENDING_VECTOR_PROJECTION_SOURCES) {
    const spec = ARCHIVE_CANONICAL_TABLES.find((candidate) => candidate.table === source.table);
    if (!spec) continue;
    try {
      if (!tableExists(db, spec.table)) continue;
      const owner = buildArchiveOwnerPredicate(spec, userId, "archive_row");
      const clauses = [owner?.sql, spec.extraWhere ? `(${spec.extraWhere})` : null, source.pending]
        .filter((clause): clause is string => typeof clause === "string" && clause.length > 0);
      const sql = `SELECT 1 AS pending FROM "${spec.table}" AS archive_row WHERE ${clauses.join(" AND ")} LIMIT 1`;
      if (db.query(sql).get(...(owner?.params ?? []))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function existingPath(candidate: string, allowedRoot?: string): string | null {
  try {
    return validateRegularPath(candidate, allowedRoot);
  } catch (error) {
    // Optional references may be absent at the first lookup. Once a path
    // exists, every validation/read/identity failure is export-fatal.
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function encodeArchiveOwnerKey(
  spec: { readonly primaryKey: readonly string[] },
  row: Record<string, unknown>,
): string {
  const keys = spec.primaryKey.length > 0 ? spec.primaryKey : ["id"];
  return keys.map((column) => encodeURIComponent(String(row[column] ?? ""))).join(":");
}

export function archivePathForRef(
  ref: Pick<ArchiveFileRefV2, "bucket" | "archivePath">,
  row: Record<string, unknown>,
  absolutePath: string,
): string {
  const bucket = String(ref.bucket).replace(/^\/+|\/+$/g, "");
  const inner = String(typeof ref.archivePath === "function" ? ref.archivePath(row, absolutePath) : basename(absolutePath))
    .replace(/^\/+/, "");
  if (!inner || inner === "." || inner.includes("..")) throw new Error(`Invalid archive file path: ${inner}`);
  const path = `files/${bucket}/${inner}`;
  if (path === "manifest.json" || path.includes("//")) throw new Error(`Invalid archive file path: ${path}`);
  return path;
}

function descriptorInput(
  kind: ArchiveFileKind,
  ownerTable: string,
  ownerKey: string,
  path: string,
  required: boolean,
  archivePath?: string,
  allowedRoot?: string,
  maxBytes?: number,
): FreezeFileInput {
  return { kind, ownerTable, ownerKey, path, required, archivePath, allowedRoot, maxBytes };
}

function cloneFrozenFileDescriptor(
  descriptor: FrozenFileDescriptorV1,
  input: FreezeFileInput,
): FrozenFileDescriptorV1 {
  return Object.freeze({
    ...descriptor,
    kind: input.kind,
    ownerTable: input.ownerTable,
    ownerKey: input.ownerKey,
    owner: Object.freeze({ table: input.ownerTable, key: input.ownerKey }),
    required: input.required ?? false,
    ...(input.archivePath ? { archivePath: input.archivePath } : {}),
  });
}

async function enumerateSnapshotFiles(db: Database, userId: string): Promise<FrozenFileDescriptorV1[]> {
  const files: FrozenFileDescriptorV1[] = [];
  const dataRoot = resolve(env.dataDir);
  const seenBindings = new Set<string>();
  const descriptorsBySource = new Map<string, FrozenFileDescriptorV1>();
  let uniqueFileCount = 0;
  let uniqueFileBytes = 0;
  const appendOnce = async (input: FreezeFileInput): Promise<void> => {
    const sourcePath = resolve(input.path);
    const sourceRoot = resolve(input.allowedRoot ?? dirname(sourcePath));
    const bindingKey = [
      input.kind,
      input.ownerTable,
      input.ownerKey,
      sourcePath,
      input.archivePath ?? "",
    ].join("\u0000");
    if (seenBindings.has(bindingKey)) return;
    if (files.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`archive contains too many file references (>${MAX_ARCHIVE_ENTRIES})`);
    }
    seenBindings.add(bindingKey);
    const sourceKey = `${sourcePath}\u0000${sourceRoot}`;
    const prior = descriptorsBySource.get(sourceKey);
    if (prior) {
      const maxBytes = input.maxBytes ?? MAX_FROZEN_FILE_BYTES;
      if (prior.bytes > maxBytes) {
        throw new Error(`Archive file exceeds its reference limit: ${sourcePath}`);
      }
      files.push(cloneFrozenFileDescriptor(prior, { ...input, path: sourcePath, allowedRoot: sourceRoot }));
      return;
    }
    if (uniqueFileCount >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`archive contains too many staged files (>${MAX_ARCHIVE_ENTRIES})`);
    }
    const remainingBytes = MAX_ARCHIVE_TOTAL_BYTES - uniqueFileBytes;
    if (remainingBytes < 0) {
      throw new Error(`staged archive files exceed ${MAX_ARCHIVE_TOTAL_BYTES} bytes`);
    }
    const descriptor = await freezeFileDescriptor({
      ...input,
      path: sourcePath,
      allowedRoot: sourceRoot,
      maxBytes: Math.min(input.maxBytes ?? MAX_FROZEN_FILE_BYTES, remainingBytes),
    });
    if (descriptor.bytes > remainingBytes) {
      throw new Error(`staged archive files exceed ${MAX_ARCHIVE_TOTAL_BYTES} bytes`);
    }
    descriptorsBySource.set(sourceKey, descriptor);
    uniqueFileCount++;
    uniqueFileBytes += descriptor.bytes;
    files.push(descriptor);
  };
  for (const spec of ARCHIVE_CANONICAL_TABLES) {
    if (spec.fileRefs.length === 0 || !tableExists(db, spec.table)) continue;
    const owner = buildArchiveOwnerPredicate(spec, userId, "archive_row");
    const where = owner ? ` WHERE ${owner.sql}${spec.extraWhere ? ` AND (${spec.extraWhere})` : ""}` : spec.extraWhere ? ` WHERE ${spec.extraWhere}` : "";
    const rows = safeRows<Record<string, unknown>>(db, `SELECT * FROM "${spec.table}" AS archive_row${where}`, owner?.params ?? []);
    for (const row of rows) {
      const key = encodeArchiveOwnerKey(spec, row);
      for (const ref of spec.fileRefs) {
        const paths = ref.resolve(row, dataRoot);
        for (const path of paths) {
          const resolution = resolveArchiveSourcePath({
            sourcePath: path,
            bucket: ref.bucket,
            row,
            dataDir: dataRoot,
            userId,
          });
          const absolute = existingPath(resolution.path, resolution.allowedRoot);
          if (!absolute) {
            if (ref.required) {
              throw new Error(`required archive file is missing from the snapshot: ${resolution.path}`);
            }
            continue;
          }
          const archivePath = archivePathForRef(ref, row, absolute);
          const kind: ArchiveFileKind = ref.bucket === "images" ? "image"
            : ref.bucket === "thumbnails" ? "thumbnail"
            : ref.bucket === "avatars" ? "avatar"
            : ref.bucket === "audio" ? "audio"
            : ref.bucket === "databank" ? "databank_document"
            : ref.bucket === "artifacts" ? "image_variant"
            : "theme_asset";
          await appendOnce(descriptorInput(
            kind,
            spec.table,
            key,
            absolute,
            ref.required,
            archivePath,
            resolution.allowedRoot,
            strictestMediaLimit(ref.bucket, ref.maxBytes, ref.mediaPolicy) ?? MAX_FROZEN_FILE_BYTES,
          ));
        }
      }
    }
  }
  const notificationRoot = join(dataRoot, "notification-sounds", userId);
  for (const extension of [".mp3", ".wav", ".ogg", ".aac", ".m4a"]) {
    const candidate = resolveArchivePathWithinRoot(join(notificationRoot, `completion${extension}`), notificationRoot);
    const sound = existingPath(candidate);
    if (sound) {
      await appendOnce(descriptorInput(
        "notification_sound",
        "notification_sounds",
        userId,
        sound,
        false,
        `files/notification-sounds/${basename(sound)}`,
        notificationRoot,
        strictestMediaLimit("notification-sounds", undefined, "notification_audio") ?? MAX_FROZEN_FILE_BYTES,
      ));
    }
  }
  return files;
}

function openSnapshotDatabase(): Database {
  const dbPath = getDatabasePath();
  const current = getDb();
  const inMemory = dbPath === ":memory:" || current.filename === ":memory:" || dbPath.length === 0;
  const snapshot = inMemory
    ? Database.deserialize(current.serialize(), { readonly: true })
    : new Database(dbPath, { readonly: true });
  try {
    snapshot.run("PRAGMA query_only = ON");
    snapshot.run("PRAGMA foreign_keys = ON");
    snapshot.run("PRAGMA busy_timeout = 5000");
    // Establish the read view before any schema/data query. Keep this open
    // until close() so all relational rows share one point-in-time view.
    snapshot.run("BEGIN DEFERRED");
    return snapshot;
  } catch (error) {
    snapshot.close();
    throw error;
  }
}

/**
 * Open a dedicated read-only SQLite snapshot and freeze the file references
 * visible to that read transaction. The caller owns close(); close is
 * idempotent and rolls back the read transaction before closing the handle.
 */
export async function openUserDataReadSnapshot(userId: string): Promise<UserDataReadSnapshot> {
  if (!userId || typeof userId !== "string") throw new TypeError("userId is required");
  const db = openSnapshotDatabase();
  const snapshotId = randomUUID();
  const projection = userDataSnapshotBarrier.getProjectionStamp(userId);
  let files: readonly FrozenFileDescriptorV1[];
  let sourceDigest: string;
  try {
    files = Object.freeze(await enumerateSnapshotFiles(db, userId));
    sourceDigest = computeUserDataSourceDigest(db, userId);
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* already failed */ }
    db.close();
    throw error;
  }
  let closed = false;
  return {
    db,
    snapshotId,
    files,
    sourceDigest,
    projection,
    close() {
      if (closed) return;
      closed = true;
      try {
        if (db.inTransaction) db.run("ROLLBACK");
      } catch {
        // Closing a read-only connection is the final cleanup if rollback is
        // already implicit after an I/O failure.
      } finally {
        db.close();
      }
    },
  };
}
