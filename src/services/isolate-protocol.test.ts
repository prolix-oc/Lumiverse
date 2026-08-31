import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeJsonFrame,
  encodeLengthPrefixedJson,
  IsolateProtocolError,
  LengthPrefixedFrameDecoder,
  readFrameLength,
} from "./isolate-protocol";

describe("isolate framed protocol", () => {
  test("round-trips fragmented frames", () => {
    const frame = encodeLengthPrefixedJson({ ok: true, text: "fragmented" });
    const decoder = new LengthPrefixedFrameDecoder();
    const first = decoder.push(frame.subarray(0, 2));
    const second = decoder.push(frame.subarray(2, 7));
    const third = decoder.push(frame.subarray(7));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(decodeJsonFrame<{ ok: boolean; text: string }>(third[0])).toEqual({ ok: true, text: "fragmented" });
    decoder.finish();
  });

  test("rejects an oversized prefix before allocating payload storage", () => {
    const prefix = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(() => readFrameLength(prefix, 1024)).toThrow(IsolateProtocolError);
    const decoder = new LengthPrefixedFrameDecoder(1024);
    expect(() => decoder.push(prefix)).toThrow(/exceeds maximum/);
  });

  test("rejects an oversized ArrayLike before copying indexed bytes", () => {
    let indexedBytesRead = 0;
    const oversized: ArrayLike<number> = {
      length: 1_029,
      get 0() {
        indexedBytesRead++;
        return 0xff;
      },
    };
    expect(() => readFrameLength(oversized, 1_024)).toThrow(/maximum/);
    expect(indexedBytesRead).toBe(0);
  });

  test("rejects zero and truncated frames", () => {
    expect(() => readFrameLength(new Uint8Array([0, 0, 0, 0]))).toThrow(/positive/);
    const decoder = new LengthPrefixedFrameDecoder(DEFAULT_ISOLATE_MAX_FRAME_BYTES);
    const frame = encodeLengthPrefixedJson({ ok: true });
    decoder.push(frame.subarray(0, frame.length - 1));
    expect(() => decoder.finish()).toThrow(/middle of a frame/);
  });

  test("enforces the output frame cap before serialization crosses transport", () => {
    expect(() => encodeLengthPrefixedJson({ text: "x".repeat(100) }, 32)).toThrow(/maximum is 32/);
  });
});
