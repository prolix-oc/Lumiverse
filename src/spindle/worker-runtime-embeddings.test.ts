import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const mode of ["worker", "process"] as const) {
  test(`Embeddings namespace and cancellation work over ${mode} transport`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `spindle-embeddings-${mode}-`));
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      const input = { texts: ['Open settings'], connection_id: 'profile', input_type: 'query', userId: 'alice' };
      spindle.registerMacro({ name: 'embed', handler: () => spindle.embeddings.embed(input) });
      const connections = await spindle.embeddings.listConnections({ userId: 'alice' });
      const result = await spindle.embeddings.embed(input);
      let preAborted, cancelled;
      const before = new AbortController(); before.abort();
      try { await spindle.embeddings.embed(input, { signal: before.signal }); }
      catch (error) { preAborted = error.name; }
      const during = new AbortController();
      const pending = spindle.embeddings.embed({ ...input, texts: ['slow'] }, { signal: during.signal });
      during.abort();
      try { await pending; } catch (error) { cancelled = error.name; }
      spindle.sendToFrontend({ connections, result, preAborted, cancelled, capability: spindle.host?.capabilities?.['embeddings-v1'] ?? null });
    `);
    const completed = Promise.withResolvers<any>();
    const macro = Promise.withResolvers<any>();
    const received: any[] = [];
    let send: (message: unknown) => void;
    const onMessage = (message: any) => {
      received.push(message);
      if (message.type === "permissions_get_granted") send({ type: "response", requestId: message.requestId, result: ["embeddings"] });
      else if (message.type === "embeddings_connections_list") send({ type: "response", requestId: message.requestId, result: [{ id: "profile", is_primary: true }] });
      else if (message.type === "embeddings_embed" && message.input.texts[0] !== "slow") send({ type: "response", requestId: message.requestId, result: { embeddings: [[0.5, 0.25]], connection_id: "profile", model: "m", dimensions: 2 } });
      else if (message.type === "embeddings_cancel") send({ type: "response", requestId: message.requestId, error: "AbortError: Embeddings request cancelled" });
      else if (message.type === "frontend_message") completed.resolve(message.payload);
      else if (message.type === "macro_result") macro.resolve(message);
      else if (message.type === "log" && message.level === "error") completed.reject(new Error(message.message));
    };
    let worker: Worker | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const runtime = join(import.meta.dir, "worker-runtime.ts");
    if (mode === "worker") {
      worker = new Worker(runtime);
      worker.onmessage = (event) => onMessage(event.data);
      worker.onerror = (error) => completed.reject(error);
      send = (message) => worker!.postMessage(message);
    } else {
      child = Bun.spawn([process.execPath, runtime], { stdout: "ignore", stderr: "pipe", ipc: onMessage });
      send = (message) => child!.send(message);
    }
    const timer = setTimeout(() => { completed.reject(new Error("Embeddings worker timed out")); macro.reject(new Error("Embeddings macro timed out")); }, 5000);
    try {
      send({
        type: "init",
        manifest: { identifier: "embeddings_runtime", entry_backend: pathToFileURL(entry).href, permissions: ["embeddings"] },
        storagePath: directory,
        host: { descriptorVersion: 1, lumiverseVersion: "test", capabilities: { "embeddings-v1": 1 }, extensionInstallationId: "embeddings_runtime" },
      });
      expect(await completed.promise).toEqual({
        connections: [{ id: "profile", is_primary: true }],
        result: { embeddings: [[0.5, 0.25]], connection_id: "profile", model: "m", dimensions: 2 },
        preAborted: "AbortError", cancelled: "AbortError", capability: 1,
      });
      expect(received.find((m) => m.type === "embeddings_connections_list").userId).toBe("alice");
      expect(received.filter((m) => m.type === "embeddings_embed")).toHaveLength(2);
      const request = received.find((m) => m.type === "embeddings_embed" && m.input.texts[0] === "slow");
      expect(request.input).toEqual({ texts: ["slow"], connection_id: "profile", input_type: "query", userId: "alice" });
      expect(request).not.toHaveProperty("signal");
      expect(received.find((m) => m.type === "embeddings_cancel").requestId).toBe(request.requestId);
      send({ type: "event", event: "__macro_invoke__", payload: { requestId: "preview", name: "embed", context: { commit: false } } });
      expect((await macro.promise).error).toContain("not allowed during non-committing macro resolution");
      expect(received.filter((m) => m.type === "embeddings_embed")).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
