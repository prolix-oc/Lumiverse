import { deserialize, serialize } from "node:v8";

/** Binary framing retains undefined metadata deletions, blobs, and bigint. */
export function encodeSubprocessMessage(message: unknown): Buffer {
  const body = serialize(message);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

/** Incremental decoder shared by pipe readers and socket data callbacks. */
export class SubprocessMessageDecoder {
  private header = Buffer.allocUnsafe(4);
  private headerOffset = 0;
  private body: Buffer | null = null;
  private bodyOffset = 0;

  push(value: Uint8Array, receive: (message: unknown) => void): void {
    let offset = 0;
    while (offset < value.byteLength) {
      if (!this.body) {
        const count = Math.min(4 - this.headerOffset, value.byteLength - offset);
        this.header.set(value.subarray(offset, offset + count), this.headerOffset);
        offset += count;
        this.headerOffset += count;
        if (this.headerOffset !== 4) continue;
        const length = this.header.readUInt32BE();
        if (length === 0 || length > 0x7fffffff) throw new Error("Invalid subprocess message length");
        this.body = Buffer.allocUnsafe(length);
        this.bodyOffset = 0;
      }
      const count = Math.min(this.body.byteLength - this.bodyOffset, value.byteLength - offset);
      this.body.set(value.subarray(offset, offset + count), this.bodyOffset);
      offset += count;
      this.bodyOffset += count;
      if (this.bodyOffset === this.body.byteLength) {
        const message = deserialize(this.body) as unknown;
        this.body = null;
        this.headerOffset = 0;
        receive(message);
      }
    }
  }

  finish(): void {
    if (this.headerOffset !== 0 || this.body) throw new Error("Subprocess message stream ended mid-frame");
  }
}

export async function readSubprocessMessages(
  stream: ReadableStream<Uint8Array>,
  receive: (message: unknown) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new SubprocessMessageDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      decoder.push(value, receive);
    }
    decoder.finish();
  } finally {
    reader.releaseLock();
  }
}
