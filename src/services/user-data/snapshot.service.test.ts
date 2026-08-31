import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UserDataSnapshotBarrier,
  freezeFileDescriptor,
  encodeArchiveOwnerKey,
  resolveArchivePathWithinRoot,
  resolveArchiveSourcePath,
  stageFrozenFile,
} from "./snapshot";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("user-data snapshot barrier", () => {
  test("exclusive export is FIFO against active and later mutations", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMutation = barrier.withMutation("user-1", async () => {
      events.push("mutation-1-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("mutation-1-end");
    });
    await Promise.resolve();
    const exportRun = barrier.withExclusive("user-1", async () => {
      events.push("export-start");
      await Promise.resolve();
      events.push("export-end");
    });
    const secondMutation = barrier.withMutation("user-1", async () => {
      events.push("mutation-2");
    });

    expect(events).toEqual(["mutation-1-start"]);
    releaseFirst();
    await Promise.all([firstMutation, exportRun, secondMutation]);
    expect(events).toEqual([
      "mutation-1-start",
      "mutation-1-end",
      "export-start",
      "export-end",
      "mutation-2",
    ]);
  });

  test("exclusive completion releases synchronous mutation access before settling", async () => {
    const barrier = new UserDataSnapshotBarrier();
    await barrier.withExclusive("user-exclusive-settlement", async () => "exported");

    expect(barrier.getState("user-exclusive-settlement")).toEqual({
      activeMutations: 0,
      activeExclusive: false,
      queued: 0,
    });
    expect(barrier.withMutationSync("user-exclusive-settlement", () => "mutated")).toBe("mutated");
  });

  test("abort releases a queued waiter without bypassing the exclusive fence", async () => {
    const barrier = new UserDataSnapshotBarrier();
    let release!: () => void;
    const active = barrier.withExclusive("user-2", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const controller = new AbortController();
    const queued = barrier.withMutation("user-2", async () => "not-run", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    release();
    const after = barrier.withMutation("user-2", async () => "ran");
    await Promise.all([active, after]);
    expect(barrier.getState("user-2")).toEqual({ activeMutations: 0, activeExclusive: false, queued: 0 });
  });
  test("records projection coverage only for the source epoch it observed", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const sourceDigest = "a".repeat(64);
    const before = barrier.getProjectionStamp("user-epoch");
    await barrier.withProjection("user-epoch", before.sourceEpoch, sourceDigest, async () => undefined);
    const covered = barrier.getProjectionStamp("user-epoch");
    expect(covered.projectedSourceEpoch).toBe(before.sourceEpoch);
    expect(covered.projectedSourceDigest).toBe(sourceDigest);

    await barrier.withMutation("user-epoch", async () => undefined);
    const changed = barrier.getProjectionStamp("user-epoch");
    expect(changed.sourceEpoch).toBeGreaterThan(before.sourceEpoch);
    expect(changed.projectedSourceEpoch).toBe(before.sourceEpoch);
  });

  test("source edit racing an embedding projection cannot claim new coverage", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const sourceDigest = "b".repeat(64);
    const before = barrier.getProjectionStamp("user-race");
    let releaseProjection!: () => void;
    const projection = barrier.withProjection("user-race", before.sourceEpoch, sourceDigest, async () => {
      await new Promise<void>((resolve) => { releaseProjection = resolve; });
    });
    await Promise.resolve();
    const sourceEdit = barrier.withMutation("user-race", async () => undefined);
    releaseProjection();
    await Promise.all([projection, sourceEdit]);
    const after = barrier.getProjectionStamp("user-race");
    expect(after.sourceEpoch).toBeGreaterThan(before.sourceEpoch);
    expect(after.projectedSourceEpoch).not.toBe(after.sourceEpoch);
  });

  test("nested purge helpers reuse the held exclusive lease without deadlocking", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const events: string[] = [];
    await barrier.withExclusive("user-nested", async () => {
      events.push("purge-start");
      await barrier.withMutation("user-nested", async () => {
        events.push("artifact-mutation");
      });
      events.push("purge-end");
    });
    expect(events).toEqual(["purge-start", "artifact-mutation", "purge-end"]);
  });

  test("export-first and purge-first exclusive operations converge in FIFO order", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const firstEvents: string[] = [];
    let releaseExport!: () => void;
    const exportRun = barrier.withExclusive("user-order-1", async () => {
      firstEvents.push("export-start");
      await new Promise<void>((resolve) => { releaseExport = resolve; });
      firstEvents.push("export-end");
    });
    const purgeRun = barrier.withExclusive("user-order-1", async () => {
      firstEvents.push("purge");
    });
    releaseExport();
    await Promise.all([exportRun, purgeRun]);
    expect(firstEvents).toEqual(["export-start", "export-end", "purge"]);

    const secondEvents: string[] = [];
    let releasePurge!: () => void;
    const purgeFirst = barrier.withExclusive("user-order-2", async () => {
      secondEvents.push("purge-start");
      await new Promise<void>((resolve) => { releasePurge = resolve; });
      secondEvents.push("purge-end");
    });
    const exportSecond = barrier.withExclusive("user-order-2", async () => {
      secondEvents.push("export");
    });
    releasePurge();
    await Promise.all([purgeFirst, exportSecond]);
    expect(secondEvents).toEqual(["purge-start", "purge-end", "export"]);
  });

  test("an exclusive holder settles within the deadlock timeout while a mutation is queued", async () => {
    const barrier = new UserDataSnapshotBarrier();
    const queued = barrier.withMutation("user-deadlock-safe", async () => "queued");
    const purge = barrier.withExclusive("user-deadlock-safe", async () => "purged");
    expect(await purge).toBe("purged");
    expect(await queued).toBe("queued");
  });

  test("an exclusive holder that awaits a barrier-queued mutation cannot make progress", async () => {
    const barrier = new UserDataSnapshotBarrier();
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    let resolveQueuedMutationStarted!: () => void;
    const queuedMutationStarted = new Promise<void>((resolve) => { resolveQueuedMutationStarted = resolve; });
    let purgeFinished = false;
    const purge = barrier.withExclusive("user-deadlock", async () => {
      // Stand-in for cancelling live work after taking the lease: the awaited
      // mutation can only run once this callback returns.
      await Promise.race([queuedMutationStarted, blocked]);
      purgeFinished = true;
      return "purged";
    });
    const queuedMutation = barrier.withMutation("user-deadlock", async () => {
      resolveQueuedMutationStarted();
      return "mutated";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(purgeFinished).toBe(false);
    releaseBlocked();
    expect(await purge).toBe("purged");
    expect(await queuedMutation).toBe("mutated");
  });


});
describe("frozen archive files", () => {
  test("encodes composite owner keys without delimiter collisions", () => {
    const spec = { primaryKey: ["left", "right"] };
    const first = encodeArchiveOwnerKey(spec, { left: "a:b", right: "c" });
    const second = encodeArchiveOwnerKey(spec, { left: "a", right: "b:c" });
    expect(first).toBe("a%3Ab:c");
    expect(second).toBe("a:b%3Ac");
    expect(first).not.toBe(second);
  });

  test("descriptor binds owner, identity, byte count, and digest and rejects replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lumiverse-snapshot-test-"));
    tempDirs.push(dir);
    const source = join(dir, "source.bin");
    await writeFile(source, Buffer.from("original payload"));
    const descriptor = await freezeFileDescriptor({
      kind: "audio",
      ownerTable: "audio_files",
      ownerKey: "audio-1",
      path: source,
      required: true,
    });
    expect(descriptor.owner).toEqual({ table: "audio_files", key: "audio-1" });
    expect(descriptor.bytes).toBe(Buffer.byteLength("original payload"));
    expect(descriptor.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.sourceIdentity.inode).toBeGreaterThan(0);

    const replacement = join(dir, "replacement.bin");
    await writeFile(replacement, Buffer.from("replacement payload"));
    await rename(replacement, source);
    await expect(stageFrozenFile(descriptor, join(dir, "stage"))).rejects.toThrow(/replaced|changed/);
  });

  test("accepts a file exactly at the frozen cap and rejects cap plus one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lumiverse-snapshot-cap-"));
    tempDirs.push(dir);
    const source = join(dir, "source.bin");
    const payload = Buffer.from("exact cap payload");
    await writeFile(source, payload);

    const descriptor = await freezeFileDescriptor({
      kind: "audio",
      ownerTable: "audio_files",
      ownerKey: "audio-cap",
      path: source,
      maxBytes: payload.byteLength,
    });
    expect(descriptor.bytes).toBe(payload.byteLength);
    const staged = await stageFrozenFile(descriptor, join(dir, "stage"), { maxBytes: payload.byteLength });
    expect(staged.bytes).toBe(payload.byteLength);
    const overSource = join(dir, "source-over-cap.bin");
    await writeFile(overSource, Buffer.concat([payload, Buffer.from("!")]));
    await expect(
      freezeFileDescriptor({
        kind: "audio",
        ownerTable: "audio_files",
        ownerKey: "audio-over-cap",
        path: overSource,
        maxBytes: payload.byteLength,
      }),
    ).rejects.toThrow(/exceeds|limit/);
    await expect(
      stageFrozenFile(descriptor, join(dir, "stage-over"), { maxBytes: payload.byteLength - 1 }),
    ).rejects.toThrow(/exceeds|limit/);
  });

  test("fails an optional file when it is replaced after the initial freeze", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lumiverse-snapshot-optional-race-"));
    tempDirs.push(dir);
    const source = join(dir, "source.bin");
    await writeFile(source, Buffer.from("optional original"));
    const descriptor = await freezeFileDescriptor({
      kind: "audio",
      ownerTable: "audio_files",
      ownerKey: "optional-race",
      path: source,
      required: false,
    });

    const replacement = join(dir, "replacement.bin");
    await writeFile(replacement, Buffer.from("optional replacement"));
    await rename(replacement, source);
    await expect(stageFrozenFile(descriptor, join(dir, "stage"))).rejects.toThrow(/replaced|changed/);
  });

  test("staging returns an immutable staged path with stable bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lumiverse-snapshot-test-"));
    tempDirs.push(dir);
    const source = join(dir, "source.bin");
    await writeFile(source, Buffer.from("stable payload"));
    const descriptor = await freezeFileDescriptor({
      kind: "databank_document",
      ownerTable: "databank_documents",
      ownerKey: "doc-1",
      path: source,
      required: true,
    });
    const staged = await stageFrozenFile(descriptor, join(dir, "stage"));
    expect(staged.stagedPath).toBe(staged.path);
    expect(await Bun.file(staged.stagedPath).text()).toBe("stable payload");
    expect((await Bun.file(staged.stagedPath).stat()).mode & 0o222).toBe(0);
  });

  test("rejects traversal and symlink escapes for every archive file bucket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lumiverse-snapshot-containment-"));
    tempDirs.push(dir);
    const dataDir = join(dir, "data");
    const userId = "user-containment";
    const cases = [
      { bucket: "images", row: { user_id: userId }, root: join(dataDir, "images") },
      { bucket: "thumbnails", row: { user_id: userId }, root: join(dataDir, "images") },
      { bucket: "avatars", row: { user_id: userId }, root: join(dataDir, "avatars") },
      { bucket: "audio", row: { user_id: userId }, root: join(dataDir, "audio") },
      { bucket: "databank", row: { user_id: userId }, root: join(dataDir, "databank", userId) },
      { bucket: "theme-assets", row: { user_id: userId, bundle_id: "bundle-1" }, root: join(dataDir, "theme-assets", userId, "bundle-1") },
      { bucket: "artifacts", row: { user_id: userId }, root: join(dataDir, "agent-artifacts", userId) },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      await mkdir(entry.root, { recursive: true });
      const traversal = `${entry.root}/../outside-${index}.bin`;
      expect(() => resolveArchiveSourcePath({
        sourcePath: traversal,
        bucket: entry.bucket,
        row: entry.row,
        dataDir,
        userId,
      })).toThrow(/traversal|outside/);

      const outside = join(dir, `outside-${index}`);
      await mkdir(outside, { recursive: true });
      const escape = join(entry.root, `escape-${index}`);
      await symlink(outside, escape, "dir");
      expect(() => resolveArchiveSourcePath({
        sourcePath: join(escape, "missing.bin"),
        bucket: entry.bucket,
        row: entry.row,
        dataDir,
        userId,
      })).toThrow(/outside/);
    }

    const notificationRoot = join(dataDir, "notification-sounds", userId);
    await mkdir(notificationRoot, { recursive: true });
    const notificationOutside = join(dir, "notification-outside");
    await mkdir(notificationOutside, { recursive: true });
    await symlink(notificationOutside, join(notificationRoot, "escape"), "dir");
    expect(() => resolveArchivePathWithinRoot(join(notificationRoot, "escape", "completion.mp3"), notificationRoot)).toThrow(/outside/);
  });
});
