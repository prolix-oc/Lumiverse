import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { COGNITION_MAX_STRING_BYTES } from "../types/agent-cognition";
import { fetchVerifiedSealedBlocks, materializePortableSealedPresetImport, type SealedManifest } from "./sealed-presets";

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

  test("rejects an oversized portable descriptor before link resolution", async () => {
    const preset = {
      prompt_order: [{
        content: "{{presetBlock::private}}",
        sealed: true,
        sealedSource: "lumihub",
      }],
      metadata: {
        portableSealedPreset: {
          hubPresetId: "x".repeat(COGNITION_MAX_STRING_BYTES + 1),
          hubPresetVersion: "1",
          blocks: [{ key: "private", sha256: "a".repeat(64) }],
        },
      },
    };

    await expect(materializePortableSealedPresetImport("user", preset))
      .rejects.toThrow("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  });
  test("materializes exact unmarked placeholders and verifies the resolver digest", async () => {
    const content = "resolved private content";
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const importedBlocks: unknown[] = [{ content: "{{pblock::private}}" }];
    let resolverCalls = 0;
    const materialized = await materializePortableSealedPresetImport(
      "user",
      {
        prompt_order: importedBlocks,
        metadata: {
          portableSealedPreset: {
            hubPresetId: "preset-id",
            hubPresetVersion: "1",
            blocks: [{ key: "private", sha256 }],
          },
        },
      },
      async (userId, descriptor) => {
        resolverCalls += 1;
        expect(userId).toBe("user");
        expect(descriptor.hubPresetId).toBe("preset-id");
        expect(descriptor.hubPresetVersion).toBe("1");
        return { private: content };
      },
    );

    expect(resolverCalls).toBe(1);
    expect(materialized.prompt_order).toEqual([{
      content,
      sealed: true,
      sealedKey: "private",
      sealedSource: "lumihub",
      sealedOriginPresetId: "preset-id",
      sealedOriginVersion: "1",
      sealedSha256: sha256,
    }]);
  });

  test("rejects plaintext, contradictory, and non-one-to-one sealed descriptors before resolution", async () => {
    const digest = "a".repeat(64);
    const descriptor = {
      hubPresetId: "preset-id",
      hubPresetVersion: "1",
      blocks: [{ key: "private", sha256: digest }],
    };
    const cases = [
      { content: "plaintext", sealed: true },
      { content: "plaintext", sealedSource: "lumihub" },
      { content: "{{presetBlock::private}}", sealed: true, sealedKey: "foreign", sealedSource: "lumihub" },
      {
        content: "{{presetBlock::private}}",
        sealed: true,
        sealedKey: "private",
        sealedSource: "lumihub",
        sealedOriginPresetId: "foreign",
      },
    ];
    for (const block of cases) {
      let resolverCalls = 0;
      await expect(materializePortableSealedPresetImport(
        "user",
        { prompt_order: [block], metadata: { portableSealedPreset: descriptor } },
        async () => {
          resolverCalls += 1;
          return { private: "resolved" };
        },
      )).rejects.toThrow("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
      expect(resolverCalls).toBe(0);
    }

    let resolverCalls = 0;
    await expect(materializePortableSealedPresetImport(
      "user",
      {
        prompt_order: [{ content: "{{presetBlock::private}}", sealed: true, sealedSource: "lumihub" }],
        metadata: {
          portableSealedPreset: {
            ...descriptor,
            blocks: [
              ...descriptor.blocks,
              { key: "unreferenced", sha256: digest },
            ],
          },
        },
      },
      async () => {
        resolverCalls += 1;
        return {};
      },
    )).rejects.toThrow("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    expect(resolverCalls).toBe(0);
  });


  test("rejects an oversized sealed manifest before making a Hub request", async () => {
    let requested = false;
    const blocks = Array.from({ length: 257 }, (_, index) => ({
      key: `private-${index}`,
      sha256: "a".repeat(64),
    }));

    await expect(fetchVerifiedSealedBlocks(
      { lumihubUrl: "https://hub.example", linkToken: "token" },
      "preset-id",
      "1",
      { version: "1", blocks },
      async () => {
        requested = true;
        return Response.json({ blocks: {} });
      },
    )).rejects.toThrow("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    expect(requested).toBe(false);
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
