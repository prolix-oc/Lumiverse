import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test.each([3, 100 * 1024 * 1024])("%i image bytes survive the subprocess RPC and retain explicit user scope", async (size) => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-image-rpc-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    const bytes = await spindle.images.readBinary('asset', 'alice');
    spindle.sendToFrontend({ typed: bytes instanceof Uint8Array, size: bytes.byteLength, head: [...bytes.subarray(0, 3)], last: bytes[bytes.byteLength - 1] });
  `);
  const bytes = new Uint8Array(size);
  bytes.set([0, 0x80, 0xff]);
  bytes[size - 1] = 0xff;
  const completed = Promise.withResolvers<any>();
  let request: any;
  const timer = setTimeout(() => completed.reject(new Error("Image binary RPC timed out")), 10_000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["images"] });
      } else if (message.type === "images_read_binary") {
        request = message;
        child.send({ type: "response", requestId: message.requestId, result: bytes });
      } else if (message.type === "frontend_message") {
        completed.resolve(message.payload);
      }
    },
  });
  try {
    worker.send({ type: "init", manifest: { identifier: "image-rpc-test", entry_backend: pathToFileURL(entry).href, permissions: ["images"] }, storagePath: directory });
    expect(await completed.promise).toEqual({ typed: true, size, head: [0, 0x80, 0xff], last: 0xff });
    expect(request).toMatchObject({ imageId: "asset", userId: "alice" });
  } finally {
    clearTimeout(timer);
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
