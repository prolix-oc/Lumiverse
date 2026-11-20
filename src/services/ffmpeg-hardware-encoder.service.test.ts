import { describe, expect, test } from "bun:test";
import { hardwareVideoEncoderCandidates } from "./ffmpeg-hardware-encoder.service";

describe("ffmpeg-hardware-encoder.service", () => {
  test("uses VideoToolbox constant-quality hardware encoding on macOS", () => {
    const [candidate] = hardwareVideoEncoderCandidates("h264", "darwin");
    expect(candidate?.encoder).toBe("h264_videotoolbox");
    expect(candidate?.args).toContain("-q:v");
    expect(candidate?.args).toContain("-allow_sw");
  });

  test("orders dedicated Windows encoders before generic Media Foundation", () => {
    const candidates = hardwareVideoEncoderCandidates("hevc", "win32");
    expect(candidates.map((candidate) => candidate.encoder)).toEqual([
      "hevc_nvenc",
      "hevc_qsv",
      "hevc_amf",
      "hevc_mf",
    ]);
    expect(candidates.at(-1)?.args).toContain("-hw_encoding");
  });

  test("does not advertise device-dependent VAAPI without a configured device", () => {
    expect(hardwareVideoEncoderCandidates("h264", "linux").map((candidate) => candidate.encoder)).toEqual([
      "h264_nvenc",
      "h264_qsv",
    ]);
  });
});
