import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const mode of ["worker", "process"] as const) {
  test(`Decision namespace and cancellation work over ${mode} transport`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `spindle-decisions-${mode}-`));
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      const input = { connection_id: 'profile', userId: 'alice', state: 'Lumiverse', questions: { check: { type: 'noul', instructions: 'Mentioned?' } } };
      spindle.registerMacro({ name: 'decision', handler: () => spindle.decisions.evaluate(input) });
      const providers = await spindle.decisions.listProviders({ userId: 'alice' });
      const profiles = await spindle.decisions.listConnections({ userId: 'alice' });
      const profile = await spindle.decisions.getConnection('profile', { userId: 'alice' });
      const models = await spindle.decisions.getModels('profile', { userId: 'alice' });
      const result = await spindle.decisions.evaluate(input);
      const imageResult = await spindle.decisions.evaluate({
        ...input, state: 'ref-page', assets: { 'ref-page': { image_id: 'stored' } },
        questions: { face: { type: 'box', instructions: 'Find the face in ref-page' } },
      });
      let preAborted, cancelled;
      const before = new AbortController(); before.abort();
      try { await spindle.decisions.evaluate(input, { signal: before.signal }); }
      catch (error) { preAborted = error.name; }
      const during = new AbortController();
      const pending = spindle.decisions.evaluate({ ...input, state: 'slow' }, { signal: during.signal });
      during.abort();
      try { await pending; } catch (error) { cancelled = error.name; }
      spindle.sendToFrontend({ providers, profiles, profile, models, result, imageResult, preAborted, cancelled, granted: spindle.permissions.has('decisions') });
    `);
    const completed = Promise.withResolvers<any>();
    const macro = Promise.withResolvers<any>();
    const received: any[] = [];
    let send: (message: unknown) => void;
    const onMessage = (message: any) => {
      received.push(message);
      if (message.type === "permissions_get_granted") send({ type: "response", requestId: message.requestId, result: ["decisions"] });
      else if (message.type === "decisions_providers") send({ type: "response", requestId: message.requestId, result: [{ id: "typesafe" }] });
      else if (message.type === "decisions_connections_list") send({ type: "response", requestId: message.requestId, result: [{ id: "profile" }] });
      else if (message.type === "decisions_connection_get") send({ type: "response", requestId: message.requestId, result: { id: message.connectionId } });
      else if (message.type === "decisions_models") send({ type: "response", requestId: message.requestId, result: [{ id: "jev-latest" }] });
      else if (message.type === "decisions_evaluate" && message.input.assets) send({ type: "response", requestId: message.requestId, result: { model: "resolved", answers: { face: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.5 } } } });
      else if (message.type === "decisions_evaluate" && message.input.state !== "slow") send({ type: "response", requestId: message.requestId, result: { model: "resolved", answers: { check: { type: "noul", noul: 0.81234 } } } });
      else if (message.type === "decisions_cancel") send({ type: "response", requestId: message.requestId, error: "AbortError: Decision evaluation cancelled" });
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
    const timer = setTimeout(() => { completed.reject(new Error("Decision worker timed out")); macro.reject(new Error("Decision macro timed out")); }, 5000);
    try {
      send({ type: "init", manifest: { identifier: "decisions-runtime", entry_backend: pathToFileURL(entry).href, permissions: ["decisions"] }, storagePath: directory });
      expect(await completed.promise).toEqual({
        providers: [{ id: "typesafe" }], profiles: [{ id: "profile" }], profile: { id: "profile" }, models: [{ id: "jev-latest" }],
        result: { model: "resolved", answers: { check: { type: "noul", noul: 0.81234 } } }, preAborted: "AbortError", cancelled: "AbortError", granted: true,
        imageResult: { model: "resolved", answers: { face: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.5 } } },
      });
      expect(received.filter((m) => m.type === "decisions_evaluate")).toHaveLength(3);
      expect(received.find((m) => m.type === "decisions_evaluate" && m.input.assets).input.assets).toEqual({ "ref-page": { image_id: "stored" } });
      const request = received.find((m) => m.type === "decisions_evaluate" && m.input.state === "slow");
      expect(request.input.userId).toBe("alice");
      expect(request).not.toHaveProperty("signal");
      expect(received.find((m) => m.type === "decisions_cancel").requestId).toBe(request.requestId);
      send({ type: "event", event: "__macro_invoke__", payload: { requestId: "preview", name: "decision", context: { commit: false } } });
      expect((await macro.promise).error).toContain("not allowed during non-committing macro resolution");
      expect(received.filter((m) => m.type === "decisions_evaluate")).toHaveLength(3);
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
