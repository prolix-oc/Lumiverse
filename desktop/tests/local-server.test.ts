import { expect, test } from "bun:test";
import { LocalServerClient, resolveLocalServerSource } from "../src/local-server";
import { RunnerClient, type FullStatus } from "../src/runner-client";

test("adding a bundled runtime preserves existing checkout selections", () => {
  expect(resolveLocalServerSource(null, "/my/checkout", true)).toBe("checkout");
  expect(resolveLocalServerSource("checkout", "/my/checkout", true)).toBe("checkout");
  expect(resolveLocalServerSource("bundled", "/my/checkout", true)).toBe("bundled");
  expect(resolveLocalServerSource(null, null, true)).toBe("bundled");
  expect(resolveLocalServerSource("bundled", "/my/checkout", false)).toBe("checkout");
  expect(resolveLocalServerSource(null, null, false)).toBe("checkout");
});

class TestClient extends RunnerClient {
  calls: unknown[][] = [];
  stop: () => Promise<void> = async () => {};
  override async init() {}
  override async alive() { return false; }
  override async spawn(repoDir: string, bunPath: string) { this.calls.push(["spawn", repoDir, bunPath]); }
  override async shutdown() { this.calls.push(["shutdown"]); await this.stop(); }
  override async request<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    this.calls.push(["request", type, payload, timeoutMs]);
    return {} as T;
  }
  override async fullStatus(): Promise<FullStatus> { return { port: 9123 } as FullStatus; }
}

test("checkout launches and update commands continue to use the source runner", async () => {
  const checkout = new TestClient();
  const bundled = new TestClient();
  const client = new LocalServerClient({ checkout, bundled });
  await client.init("checkout");
  await client.spawn("/my/checkout", "/my/bun");
  await client.request("apply-update", { branch: "staging" }, 60_000);
  expect(await client.fullStatus()).toEqual({ port: 9123 });
  expect(checkout.calls).toEqual([
    ["spawn", "/my/checkout", "/my/bun"],
    ["request", "apply-update", { branch: "staging" }, 60_000],
  ]);
  expect(bundled.calls).toEqual([]);
});

test("switching waits for shutdown before selecting the other server", async () => {
  const checkout = new TestClient();
  const bundled = new TestClient();
  const client = new LocalServerClient({ checkout, bundled });
  await client.init("checkout");
  let stopped!: () => void;
  checkout.stop = () => new Promise<void>((resolve) => { stopped = resolve; });
  const switching = client.select("bundled");
  expect(client.source).toBe("checkout");
  stopped();
  await switching;
  expect(client.source).toBe("bundled");
  await client.spawn("", "");
  expect(checkout.calls).toEqual([["shutdown"]]);
  expect(bundled.calls).toEqual([["spawn", "", ""]]);
});

test("late events from a previous server cannot change the active tray state", async () => {
  const checkout = new TestClient();
  const bundled = new TestClient();
  const client = new LocalServerClient({ checkout, bundled });
  await client.init("checkout");
  const events: unknown[] = [];
  client.onState = (state) => events.push(state);
  client.onExit = (code) => events.push(code);
  client.onProgress = (_, message) => events.push(message);
  await client.select("bundled");
  checkout.onState?.("crashed");
  checkout.onExit?.(1);
  checkout.onProgress?.("update", "Old update");
  bundled.onState?.("running");
  expect(events).toEqual(["running"]);
});

test("changing checkout folders stops the previous runner even when the source is unchanged", async () => {
  const checkout = new TestClient();
  const client = new LocalServerClient({ checkout, bundled: new TestClient() });
  await client.init("checkout");
  await client.select("checkout", true);
  await client.spawn("/second/checkout", "/my/bun");
  expect(checkout.calls).toEqual([["shutdown"], ["spawn", "/second/checkout", "/my/bun"]]);
});

test("a failed shutdown leaves the previous server selected", async () => {
  const checkout = new TestClient();
  checkout.stop = async () => { throw new Error("Could not stop"); };
  const client = new LocalServerClient({ checkout, bundled: new TestClient() });
  await client.init("checkout");
  await expect(client.select("bundled")).rejects.toThrow("Could not stop");
  expect(client.source).toBe("checkout");
});
