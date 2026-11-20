import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "../env";
import { WorkerHostFilesApi } from "./worker-host-files-api";

for (const mode of ["worker", "process"] as const) {
  test(`file and archive APIs preserve bytes and cancellation over ${mode} transport`, async () => {
    const originalDir = env.dataDir;
    const directory = await mkdtemp(join(tmpdir(), `spindle-files-${mode}-`));
    env.dataDir = directory;
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      const file = await spindle.files.create({ fileName: 'original.bin', size: 3, userId: 'alice' });
      await spindle.files.writeChunk(file.fileId, 0, new Uint8Array([0, 128, 255]), 'alice');
      await spindle.files.finish(file.fileId, 'alice');
      const zip = await spindle.archives.create([{ name: 'original.bin', source: { fileId: file.fileId } }], { userId: 'alice', maxBytes: 4096 });
      const [extracted] = await spindle.archives.extract({ fileId: zip.fileId }, { userId: 'alice', maxDecompressedBytes: 3 });
      const chunk = await spindle.files.readChunk({ fileId: extracted.file.fileId }, 0, 'alice');
      const url = await spindle.files.getDownloadUrl(zip.fileId, 'alice');
      const controller = new AbortController();
      let cancellation;
      try {
        const pending = spindle.files.fetch('http://example.invalid/slow', { userId: 'alice', maxBytes: 1, signal: controller.signal });
        controller.abort();
        await pending;
      } catch (error) { cancellation = error.name; }
      await spindle.files.delete(file.fileId, 'alice');
      spindle.sendToFrontend({ bytes: [...chunk.data], typed: chunk.data instanceof Uint8Array, url, cancellation });
    `);
    const completed = Promise.withResolvers<any>();
    const requests: any[] = [];
    const cancellation = new Set<string>();
    let send: (message: unknown) => void;
    const api = new WorkerHostFilesApi({
      extensionId: "files-transport", identifier: "files-transport", hasPermission: () => true,
      resolveEffectiveUserId: userId => userId,
      enforceScopedUser() {},
      postResponse: message => send(message),
    });
    const onMessage = (message: any) => {
      if (message.type === "permissions_get_granted") send({ type: "response", requestId: message.requestId, result: ["cors_proxy"] });
      else if (message.type === "files_fetch") {
        requests.push(message);
        cancellation.add(message.requestId);
      } else if (message.type === "files_cancel") {
        expect(cancellation.has(message.operationId)).toBe(true);
        send({ type: "response", requestId: message.operationId, error: "AbortError: File operation cancelled" });
      } else if (message.type === "frontend_message") completed.resolve(message.payload);
      else {
        if (message.requestId && (message.type.startsWith("files_") || message.type.startsWith("archives_"))) requests.push(message);
        api.dispatch(message);
      }
    };
    let worker: Worker | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const runtime = join(import.meta.dir, "worker-runtime.ts");
    if (mode === "worker") {
      worker = new Worker(runtime);
      worker.onmessage = event => onMessage(event.data);
      worker.onerror = error => completed.reject(error);
      send = message => worker!.postMessage(message);
    } else {
      child = Bun.spawn([process.execPath, runtime], { stdout: "ignore", stderr: "pipe", ipc: onMessage });
      send = message => child!.send(message);
    }
    const timer = setTimeout(() => completed.reject(new Error("File RPC timed out")), 5000);
    try {
      send({ type: "init", manifest: { identifier: "files-transport", entry_backend: pathToFileURL(entry).href, permissions: ["cors_proxy"] }, storagePath: directory });
      const result = await completed.promise;
      expect(result).toMatchObject({ bytes: [0, 128, 255], typed: true, cancellation: "AbortError" });
      expect(result.url).toStartWith("/api/v1/spindle-files/files-transport/");
      const fetchRequest = requests.find(request => request.type === "files_fetch");
      expect(fetchRequest.options).toEqual({ userId: "alice", maxBytes: 1 });
      expect(requests.filter(request => request.type !== "files_create").every(request => request.userId === "alice" || request.options?.userId === "alice")).toBe(true);
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await api.dispose();
      env.dataDir = originalDir;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
