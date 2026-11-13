import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { WorkerHost } from "./worker-host";
import { providerRegistry } from "./provider-registry";

const extensionId = "cors-policy-test";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  providerRegistry.detachWorker(extensionId);
});

type CorsResponse = {
  type: string;
  requestId: string;
  result?: { status: number; body: string; encoding?: string };
  error?: string;
};

function fixture(granted = true) {
  const host = new WorkerHost(extensionId, {
    identifier: extensionId, name: extensionId, permissions: ["cors_proxy"],
  } as SpindleManifest, {
    id: extensionId, identifier: extensionId, name: extensionId, version: "0.0.0",
    author: "", description: "", github: "", homepage: "", permissions: ["cors_proxy"],
    granted_permissions: granted ? ["cors_proxy"] : [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: true, has_backend: true, status: "stopped",
    metadata: { install_scope: "user", installed_by_user_id: "owner" },
  } satisfies ExtensionInfo);
  const posted: CorsResponse[] = [];
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    postToWorker(message: CorsResponse): void;
    handleCorsRequest(requestId: string, url: string, options: unknown): Promise<void>;
  };
  internal.hasPermission = permission => granted && permission === "cors_proxy";
  internal.postToWorker = message => { posted.push(message); };
  return { internal, posted };
}

describe("Spindle CORS content policy", () => {
  test("rejects JavaScript even if extension options try to disable filtering", async () => {
    globalThis.fetch = (async () => new Response("export default 1", {
      headers: { "content-type": "application/javascript" },
    })) as unknown as typeof fetch;
    const { internal, posted } = fixture();

    await internal.handleCorsRequest("script", "http://93.184.216.34/download", { blockJavaScript: false });

    expect(posted).toHaveLength(1);
    expect(posted[0].error).toContain("JavaScript downloads are blocked");
    expect(posted[0].result).toBeUndefined();
  });

  test("still returns ordinary JSON through the backend CORS API", async () => {
    globalThis.fetch = (async () => new Response('{"characters":[]}', {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const { internal, posted } = fixture();
    await internal.handleCorsRequest("json", "http://93.184.216.34/cards", {});
    expect(posted).toEqual([{
      type: "response", requestId: "json", result: expect.objectContaining({ status: 200, body: '{"characters":[]}' }),
    }]);
  });

  test("still validates media magic bytes for frontend proxy requests", async () => {
    const { internal, posted } = fixture();
    globalThis.fetch = (async () => new Response("export default 1", {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
    await internal.handleCorsRequest("fake-image", "http://93.184.216.34/media", { responseType: "arraybuffer" });
    expect(posted[0].error).toContain("downloaded content does not match a known image format");
    expect(posted[0].result).toBeUndefined();

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    globalThis.fetch = (async () => new Response(png, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await internal.handleCorsRequest("image", "http://93.184.216.34/media", { responseType: "arraybuffer" });
    expect(posted[1]).toEqual({
      type: "response", requestId: "image", result: expect.objectContaining({
        status: 200, body: Buffer.from(png).toString("base64"), encoding: "base64",
      }),
    });
  });

  for (const contentType of ["application/octet-stream", "binary/octet-stream; charset=utf-8"]) {
    test(`accepts recognized fonts and audio served as ${contentType}`, async () => {
      const { internal, posted } = fixture();
      const samples = [
        { mediaType: "font", bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32]) },
        { mediaType: "audio", bytes: new TextEncoder().encode("RIFF\0\0\0\0WAVE") },
      ];
      for (const { mediaType, bytes } of samples) {
        globalThis.fetch = (async () => new Response(bytes, {
          headers: { "content-type": contentType },
        })) as unknown as typeof fetch;
        await internal.handleCorsRequest(mediaType, "http://93.184.216.34/media", {
          responseType: "arraybuffer", mediaType,
        });
        expect(posted.at(-1)).toEqual({
          type: "response", requestId: mediaType, result: expect.objectContaining({
            status: 200, body: Buffer.from(bytes).toString("base64"), encoding: "base64",
          }),
        });
      }
    });

    test(`rejects invalid or mismatched media served as ${contentType}`, async () => {
      const { internal, posted } = fixture();
      for (const mediaType of ["font", "audio"]) {
        for (const body of ["export default 1", "<html>error</html>", "", mediaType === "font" ? "RIFF\0\0\0\0WAVE" : "wOF2"]) {
          globalThis.fetch = (async () => new Response(body, {
            headers: { "content-type": contentType },
          })) as unknown as typeof fetch;
          await internal.handleCorsRequest(mediaType, "http://93.184.216.34/media", {
            responseType: "arraybuffer", mediaType,
          });
          expect(posted.at(-1)?.error).toContain(`downloaded content does not match a known ${mediaType} format`);
          expect(posted.at(-1)?.result).toBeUndefined();
        }
      }
    });

    test(`does not allow images served as ${contentType}`, async () => {
      const { internal, posted } = fixture();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      globalThis.fetch = (async () => new Response(png, {
        headers: { "content-type": contentType },
      })) as unknown as typeof fetch;
      for (const options of [{ responseType: "arraybuffer" }, { responseType: "arraybuffer", mediaType: "image" }]) {
        await internal.handleCorsRequest("image", "http://93.184.216.34/media", options);
        expect(posted.at(-1)?.error).toContain("transparent proxy only serves image data");
        expect(posted.at(-1)?.result).toBeUndefined();
      }
    });
  }

  test("denies requests without the CORS permission before network access", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const { internal, posted } = fixture(false);
    await internal.handleCorsRequest("denied", "http://93.184.216.34/cards", {});
    expect(posted[0].error).toContain("CORS proxy permission not granted");
    expect(calls).toBe(0);
  });
});
