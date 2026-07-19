import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { fetchVerifiedSealedBlocks, type SealedManifest } from "./sealed-presets";

describe("LumiHub sealed preset wire contract", () => {
  test("sends the linked-instance token, requests the exact version, and verifies content", async () => {
    const content = "Private prompt\nwith preserved whitespace.";
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    let requestedUrl = "";
    let authorization = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requestedUrl = request.url;
        authorization = request.headers.get("authorization") ?? "";
        return Response.json({ blocks: { "dialogue.frame": content } });
      },
    });

    try {
      const blocks = await fetchVerifiedSealedBlocks(
        { lumihubUrl: server.url.toString(), linkToken: "instance-secret" },
        "preset/id",
        "v 2",
        { version: "v 2", blocks: [{ key: "dialogue.frame", sha256 }] },
        (url, headers) => fetch(url, { headers }),
      );

      const expected = new URL("/api/v1/presets/preset%2Fid/sealed-blocks?version=v+2", server.url);
      expect(requestedUrl).toBe(expected.toString());
      expect(authorization).toBe("Bearer instance-secret");
      expect(blocks["dialogue.frame"]).toBe(content);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a Hub response whose content does not match the manifest", async () => {
    const manifest: SealedManifest = {
      version: "1",
      blocks: [{
        key: "private",
        sha256: createHash("sha256").update("expected", "utf8").digest("hex"),
      }],
    };

    await expect(fetchVerifiedSealedBlocks(
      { lumihubUrl: "https://hub.example", linkToken: "token" },
      "preset-id",
      "1",
      manifest,
      async () => Response.json({ blocks: { private: "tampered" } }),
    )).rejects.toThrow("failed hash verification: private");
  });
});
