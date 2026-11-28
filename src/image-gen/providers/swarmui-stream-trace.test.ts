import { expect, test } from "bun:test";
import { SwarmUIImageProvider } from "./swarmui";
import { createSwarmStreamTrace } from "./swarmui-stream-trace";
import type { ImageGenProviderTraceEvent } from "../types";

// A real provider generator with independently controlled socket frames and
// image fetch. No server, GPU, timers, database or external services required.
class MockSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockSocket[] = [];
  readyState = 0;
  sends: string[] = [];
  constructor(_url: string) {
    super();
    MockSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = MockSocket.OPEN; this.dispatchEvent(new Event("open")); });
  }
  send(body: string) { this.sends.push(body); }
  frame(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  pause() { return true; }
  resume() { return true; }
  close() { this.readyState = MockSocket.CLOSED; this.dispatchEvent(new Event("close")); }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error("Mock stream did not reach expected boundary");
}

function event(events: ImageGenProviderTraceEvent[], action: string) {
  const found = events.find(e => e.action === action);
  if (!found) throw new Error(`Missing trace event: ${action}`);
  return found;
}

test("raw Swarm progress preserves both fractions and measures misleading high-water plateaus", () => {
  let now = 0;
  const events: ImageGenProviderTraceEvent[] = [];
  const trace = createSwarmStreamTrace(e => events.push(e), () => now)!;
  trace.progress(.92, .10, true);
  now = 10_000; trace.progress(.85, .25, false);
  now = 20_000; trace.progress(.89, .75, false);
  now = 40_000; trace.progress(.92, .99, true);
  now = 45_000; trace.progress(1, 1, false);
  trace.summary();
  const details = event(events, "raw-progress-summary").details!;
  expect(details.overallRegressions).toBe(1);
  expect(details.longestHighWaterPlateauMs).toBe(40_000);
  expect(details.lastOverall).toBe(1);
  expect(details.samples).toEqual([[0,.92,.10,true],[10000,.85,.25,false],[20000,.89,.75,false],[40000,.92,.99,true],[45000,1,1,false]]);
});

test("trace samples are bounded, retain first and latest, and a throwing observer is harmless", () => {
  let now = 0;
  const events: ImageGenProviderTraceEvent[] = [];
  const trace = createSwarmStreamTrace(e => { events.push(e); throw new Error("sink failed"); }, () => now)!;
  for (let i = 0; i < 100; i++) { now = i * 2_000; trace.progress(i / 100, .5, false); }
  trace.summary();
  const details = event(events, "raw-progress-summary").details!;
  const samples = details.samples as unknown[][];
  expect(samples.length).toBe(64);
  expect(samples[0][0]).toBe(0);
  expect(samples.at(-1)?.[0]).toBe(198000);
  expect(details.droppedSamples).toBe(36);
});

test("two Swarm streams remain independent: image frame precedes discard barrier and fetch", async () => {
  const originalSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const downloads: string[] = [];
  const traces: ImageGenProviderTraceEvent[][] = [[], []];
  const progress: number[][] = [[], []];
  MockSocket.instances = [];
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/API/GetNewSession")) return Response.json({ session_id: "private-session" });
    downloads.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  const provider = new SwarmUIImageProvider();
  const streams = traces.map((events) => provider.generateStream("", "http://swarm-fixture.invalid", {
    prompt: "private prompt", model: "fixture", parameters: {}, onProviderTrace(e) { events.push(e); },
  }));
  const consume = async (index: number) => {
    while (true) {
      const next = await streams[index].next();
      if (next.done) return next.value;
      if (typeof next.value.step === "number") progress[index].push(next.value.step);
    }
  };
  try {
    const results = streams.map((_, i) => consume(i));
    await until(() => MockSocket.instances.length === 2 && MockSocket.instances.every(ws => ws.sends.length === 1));
    const [a,b] = MockSocket.instances;
    a.frame({ gen_progress: { overall_percent: .92, current_percent: .1, preview: "data:image/png;base64,PRIVATE" } });
    a.frame({ gen_progress: { overall_percent: .85, current_percent: .5 } });
    a.frame({ image: "View/private-a.png" });
    await until(() => traces[0].some(e => e.action === "image-consumed"));
    expect(downloads.length).toBe(0);
    expect(traces[1].some(e => e.action === "image-frame")).toBe(false);
    b.frame({ gen_progress: { overall_percent: .53, current_percent: 0 } });
    b.frame({ image: "View/private-b.png" });
    b.frame({ discard_indices: [] });
    expect((await results[1]).imageDataUrl).toBe("data:image/png;base64,AQID");
    expect(downloads.length).toBe(1);
    expect(downloads[0].endsWith("private-b.png")).toBe(true);
    a.frame({ discard_indices: [] });
    expect((await results[0]).imageDataUrl).toBe("data:image/png;base64,AQID");
    expect(downloads.length).toBe(2);
    expect(progress).toEqual([[92,85],[53]]);
    expect(traces[0].map(e => e.action).filter(a => ["image-frame","image-consumed","batch-complete-frame","batch-complete-consumed","image-fetch-start","image-fetch-complete"].includes(a))).toEqual([
      "image-frame","image-consumed","batch-complete-frame","batch-complete-consumed","image-fetch-start","image-fetch-complete",
    ]);
    expect(JSON.stringify(traces).includes("PRIVATE")).toBe(false);
    expect(JSON.stringify(traces).includes("private-")).toBe(false);
    expect(a.sends.length + b.sends.length).toBe(2);
    expect(a.sends[0].includes("onProviderTrace")).toBe(false);
  } finally {
    for (const ws of MockSocket.instances) ws.close();
    await Promise.allSettled(streams.map(s => s.return(undefined as never)));
    globalThis.WebSocket = originalSocket;
    globalThis.fetch = originalFetch;
  }
});
