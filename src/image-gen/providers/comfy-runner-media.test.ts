import { expect, test } from "bun:test";
import { executeComfyWorkflow, findComfyMediaResult } from "./comfy-runner";

test("video selection skips image previews and collects VideoHelperSuite files", () => {
  const outputs = {
    "1": { images: [{ filename: "preview.png", type: "temp" }] },
    "2": { gifs: [{ filename: "clip.mp4", subfolder: "video", type: "output" }] },
  };
  expect(findComfyMediaResult(outputs, "video")).toEqual({ filename: "clip.mp4", subfolder: "video", type: "output" });
  expect(findComfyMediaResult(outputs, "image")?.filename).toBe("preview.png");
});
test("native SaveVideo output and explicit final output node are supported", () => {
  const outputs = {
    "1": { images: [{ filename: "first.mp4", type: "output" }], animated: [true] },
    "2": { images: [{ filename: "final.webm", type: "output" }], animated: [true] },
  };
  expect(findComfyMediaResult(outputs, "video", "2")?.filename).toBe("final.webm");
  expect(findComfyMediaResult(outputs, "video", "missing")).toBeNull();
  expect(findComfyMediaResult(outputs, "image")).toBeNull();
});
test("legacy image callers retain their original first-image selection", () => {
  const outputs = { "1": { images: [{ filename: "preview.png", type: "temp" }] }, "2": { images: [{ filename: "saved.png", type: "output" }] } };
  expect(findComfyMediaResult(outputs)?.filename).toBe("preview.png");
  expect(findComfyMediaResult(outputs, "image")?.filename).toBe("saved.png");
});

test("ComfyUI HTTP/WebSocket transport collects a video rather than its preview", async () => {
  let socket: { send(data: string): unknown } | undefined;
  let viewed = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws" && server.upgrade(request)) return;
      if (url.pathname === "/prompt") {
        setTimeout(() => socket?.send(JSON.stringify({ type: "executing", data: { prompt_id: "job", node: null } })), 10);
        return Response.json({ prompt_id: "job" });
      }
      if (url.pathname === "/history/job") return Response.json({ job: { outputs: {
        "1": { images: [{ filename: "preview.png", type: "temp" }] },
        "9": { gifs: [{ filename: "clip.mp4", type: "output" }] },
      } } });
      if (url.pathname === "/view") {
        viewed = url.searchParams.get("filename") ?? "";
        return new Response(new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]), { headers: { "Content-Type": "application/octet-stream" } });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: { open(ws) { socket = ws; }, message() {} },
  });
  try {
    const result = await executeComfyWorkflow(`http://127.0.0.1:${server.port}`, {}, AbortSignal.timeout(2000), { label: "ComfyUI test", outputMediaType: "video", outputNodeId: "9" });
    expect(viewed).toBe("clip.mp4");
    expect(result.imageDataUrl).toStartWith("data:video/mp4;base64,");
  } finally { server.stop(true); }
});
