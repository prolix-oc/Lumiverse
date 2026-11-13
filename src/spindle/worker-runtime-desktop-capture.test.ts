import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("backend worker exposes desktop capture RPC without a frontend capture bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-desktop-capture-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    spindle.onFrontendMessage(async (payload) => {
      try {
        const devices = await spindle.desktop.capture.listDevices({ userId: payload.userId });
        const status = await spindle.desktop.capture.getApprovalStatus({ deviceId: devices[0].id, connectionId: 'connection', kind: 'image', userId: payload.userId });
        if (status.approval !== 'remembered') throw new Error('approval discovery failed');
        if (await spindle.desktop.capture.finish('already-finished', { userId: payload.userId }) !== false) throw new Error('finish failed');
        const asset = await spindle.desktop.capture.request({
          deviceId: devices[0].id, connectionId: 'connection', purpose: 'Review selected content',
          kind: 'image', userId: payload.userId,
        });
        await spindle.desktop.capture.optimize({ assetId: asset.assetId, connectionId: 'connection', kind: 'image', maxEdge: 1280, format: 'jpeg', quality: 85, userId: payload.userId });
        await spindle.desktop.capture.release(asset.assetId, { userId: payload.userId });
        spindle.sendToFrontend({ captureTest: 'done', asset });
      } catch (error) {
        spindle.sendToFrontend({ captureTest: 'failed', error: error.message });
      }
    });
  `);
  const received: any[] = [];
  const listeners = new Set<() => void>();
  const asset = { assetId: "asset", kind: "image", mimeType: "image/png", width: 1, height: 1, connectionId: "connection", expiresAt: Date.now() + 1000 };
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["screen_capture", "generation"] });
      } else if (message.type === "desktop_capture_devices") {
        child.send({ type: "response", requestId: message.requestId, result: [{ id: "device", name: "Native" }] });
      } else if (message.type === "desktop_capture_request") {
        child.send({ type: "response", requestId: message.requestId, result: asset });
      } else if (message.type === "desktop_capture_optimize") {
        child.send({ type: "response", requestId: message.requestId, result: { ...asset, mimeType: 'image/jpeg' } });
      } else if (message.type === "desktop_capture_approval_status") {
        child.send({ type: "response", requestId: message.requestId, result: { deviceId: 'device', kind: 'image', approval: 'remembered', source: 'ready', checkedAt: Date.now() } });
      } else if (message.type === "desktop_capture_release") {
        child.send({ type: "response", requestId: message.requestId });
      } else if (message.type === "desktop_capture_finish") {
        child.send({ type: "response", requestId: message.requestId, result: false });
      }
      received.push(message);
      for (const listener of listeners) listener();
    },
  });
  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Worker capture RPC timed out")); }, 3000);
      const check = () => {
        const message = received.find(predicate);
        if (!message) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(message);
      };
      listeners.add(check);
      check();
    });
  }
  try {
    worker.send({ type: "init", manifest: { identifier: "capture-test", entry_backend: pathToFileURL(entry).href, permissions: ["screen_capture", "generation"] }, storagePath: directory });
    await waitFor((message) => message.message === "__worker_ready__");
    worker.send({ type: "frontend_message", userId: "alice", payload: { userId: "alice" } });
    expect(await waitFor((message) => message.type === "frontend_message" && message.payload.captureTest)).toMatchObject({ payload: { captureTest: "done", asset } });
    expect(received.find((message) => message.type === "desktop_capture_devices")).toMatchObject({ userId: "alice" });
    expect(received.find((message) => message.type === "desktop_capture_approval_status")).toMatchObject({ input: { deviceId: "device", connectionId: "connection", kind: "image", userId: "alice" } });
    expect(received.find((message) => message.type === "desktop_capture_request")).toMatchObject({ input: { deviceId: "device", connectionId: "connection", userId: "alice", kind: "image" } });
    expect(received.find((message) => message.type === "desktop_capture_optimize")).toMatchObject({ input: { assetId: "asset", connectionId: "connection", userId: "alice", kind: "image", maxEdge: 1280, format: "jpeg", quality: 85 } });
    expect(received.find((message) => message.type === "desktop_capture_release")).toMatchObject({ assetId: "asset", userId: "alice" });
    expect(received.find((message) => message.type === "desktop_capture_finish")).toMatchObject({ requestKey: "already-finished", userId: "alice" });
  } finally {
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
