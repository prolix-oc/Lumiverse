import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function readRuntimeStage(): Promise<string> {
  const dockerfile = await Bun.file(join(import.meta.dir, "..", "Dockerfile")).text();
  // The base image is pinned by digest and changes over time, so locate the
  // final stage positionally instead of matching a specific tag.
  const finalStageHeader = [...dockerfile.matchAll(/^FROM[^\n]*$/gm)].at(-1);

  if (!finalStageHeader) {
    throw new Error("Could not locate the final runtime stage in Dockerfile");
  }
  if (!/^FROM oven\/bun:\S+/.test(finalStageHeader[0])) {
    throw new Error("The final runtime stage must use a pinned oven/bun base image");
  }

  return dockerfile.slice((finalStageHeader.index ?? 0) + finalStageHeader[0].length);
}

describe("Docker runtime image", () => {
  test("ships frontend version metadata alongside dist assets", async () => {
    const runtimeStage = await readRuntimeStage();

    expect(runtimeStage).toMatch(/COPY --from=frontend-build \/app\/frontend\/dist \.\/frontend\/dist/);
    expect(runtimeStage).toMatch(/COPY --from=frontend-build \/app\/frontend\/package\.json \.\/frontend\/package\.json/);
  });
});
