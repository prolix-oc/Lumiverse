import { describe, expect, test } from "bun:test";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";

describe("ffmpeg-binary.service", () => {
  test("prefers system ffmpeg before the static fallback", async () => {
    const probes: string[] = [];

    const binary = await resolveFfmpegBinary({
      isTermuxLike: () => false,
      canExecuteBinary: async (candidate) => {
        probes.push(candidate);
        return candidate === "ffmpeg";
      },
      loadStaticBinaryPath: async () => "/tmp/ffmpeg-static",
    });

    expect(binary).toBe("ffmpeg");
    expect(probes).toEqual(["ffmpeg"]);
  });

  test("uses ffmpeg-static off Termux when system ffmpeg is unavailable", async () => {
    const probes: string[] = [];

    const binary = await resolveFfmpegBinary({
      isTermuxLike: () => false,
      canExecuteBinary: async (candidate) => {
        probes.push(candidate);
        return candidate === "/tmp/ffmpeg-static";
      },
      loadStaticBinaryPath: async () => "/tmp/ffmpeg-static",
    });

    expect(binary).toBe("/tmp/ffmpeg-static");
    expect(probes).toEqual(["ffmpeg", "/tmp/ffmpeg-static"]);
  });

  test("does not try ffmpeg-static on Termux-like runtimes", async () => {
    let staticLoadCalls = 0;

    const binary = await resolveFfmpegBinary({
      isTermuxLike: () => true,
      canExecuteBinary: async () => false,
      loadStaticBinaryPath: async () => {
        staticLoadCalls++;
        return "/tmp/ffmpeg-static";
      },
    });

    expect(binary).toBeNull();
    expect(staticLoadCalls).toBe(0);
  });
});
