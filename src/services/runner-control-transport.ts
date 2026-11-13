const RUNNER_CONTROL_PORT_ENV = "LUMIVERSE_RUNNER_CONTROL_PORT";
const RUNNER_CONTROL_TOKEN_ENV = "LUMIVERSE_RUNNER_CONTROL_TOKEN";
const AUTH_MESSAGE_TYPE = "lumiverse_runner_control_auth_v1";
const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_BYTES = MAX_FRAME_BYTES * 2;

type WritableSocket = Pick<Bun.Socket, "flush" | "write">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new Error("Runner control messages must be JSON-serializable");
  }
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`Runner control frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class RunnerControlFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    const copied = Buffer.from(chunk);
    this.buffered = this.buffered.byteLength === 0
      ? copied
      : Buffer.concat([this.buffered, copied]);

    const messages: unknown[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= FRAME_HEADER_BYTES) {
      const payloadLength = this.buffered.readUInt32BE(offset);
      if (payloadLength === 0 || payloadLength > MAX_FRAME_BYTES) {
        throw new Error(`Invalid runner control frame length: ${payloadLength}`);
      }
      if (this.buffered.byteLength - offset < FRAME_HEADER_BYTES + payloadLength) break;
      const start = offset + FRAME_HEADER_BYTES;
      const end = start + payloadLength;
      messages.push(JSON.parse(this.buffered.toString("utf8", start, end)));
      offset = end;
    }

    if (offset > 0) {
      this.buffered = offset === this.buffered.byteLength
        ? Buffer.alloc(0)
        : Buffer.from(this.buffered.subarray(offset));
    }
    if (this.buffered.byteLength > FRAME_HEADER_BYTES + MAX_FRAME_BYTES) {
      throw new Error("Runner control receive buffer exceeded its limit");
    }
    return messages;
  }
}

class RunnerControlFrameWriter {
  private frames: Buffer[] = [];
  private frameOffset = 0;
  private queuedBytes = 0;

  enqueue(message: unknown): void {
    const frame = encodeFrame(message);
    if (this.queuedBytes + frame.byteLength > MAX_QUEUE_BYTES) {
      throw new Error("Runner control send queue exceeded its limit");
    }
    this.frames.push(frame);
    this.queuedBytes += frame.byteLength;
  }

  flush(socket: WritableSocket): void {
    while (this.frames.length > 0) {
      const frame = this.frames[0]!;
      const written = socket.write(frame.subarray(this.frameOffset));
      if (written < 0) throw new Error("Runner control socket is closed");
      if (written === 0) return;
      this.frameOffset += written;
      this.queuedBytes -= written;
      if (this.frameOffset === frame.byteLength) {
        this.frames.shift();
        this.frameOffset = 0;
      }
    }
    socket.flush();
  }

  clear(): void {
    this.frames = [];
    this.frameOffset = 0;
    this.queuedBytes = 0;
  }
}

type SocketState = {
  authenticated: boolean;
  decoder: RunnerControlFrameDecoder;
};

export interface RunnerControlHost {
  readonly bootstrapEnv: Record<string, string>;
  send(message: unknown): boolean;
  close(): void;
}

export function createRunnerControlHost(options: {
  onMessage(message: unknown): void;
  onError(message: string): void;
  onDisconnect(): void;
}): RunnerControlHost {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Buffer.from(tokenBytes).toString("hex");
  const writer = new RunnerControlFrameWriter();
  const connections = new Set<Bun.Socket<SocketState>>();
  let activeSocket: Bun.Socket<SocketState> | null = null;
  let authenticatedOnce = false;
  let closed = false;
  let errorReported = false;

  const reportError = (error: unknown): void => {
    if (closed || errorReported) return;
    errorReported = true;
    options.onError(errorMessage(error));
  };

  const flush = (): void => {
    if (!activeSocket || closed) return;
    try {
      writer.flush(activeSocket);
    } catch (error) {
      reportError(error);
      activeSocket.terminate();
    }
  };

  const listener = Bun.listen<SocketState>({
    hostname: "127.0.0.1",
    port: 0,
    exclusive: true,
    data: { authenticated: false, decoder: new RunnerControlFrameDecoder() },
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.data = { authenticated: false, decoder: new RunnerControlFrameDecoder() };
        connections.add(socket);
      },
      data(socket, data) {
        try {
          for (const message of socket.data.decoder.push(data)) {
            if (!socket.data.authenticated) {
              const auth = message as { type?: unknown; token?: unknown };
              if (
                activeSocket
                || auth?.type !== AUTH_MESSAGE_TYPE
                || auth?.token !== token
              ) {
                socket.terminate();
                return;
              }
              socket.data.authenticated = true;
              authenticatedOnce = true;
              activeSocket = socket;
              listener.stop(false);
              for (const connection of connections) {
                if (connection !== socket) connection.terminate();
              }
              flush();
              continue;
            }
            options.onMessage(message);
          }
        } catch (error) {
          if (socket.data.authenticated) reportError(error);
          socket.terminate();
        }
      },
      drain(socket) {
        if (socket === activeSocket) flush();
      },
      error(socket, error) {
        if (socket.data.authenticated) reportError(error);
      },
      close(socket) {
        connections.delete(socket);
        if (socket !== activeSocket) return;
        activeSocket = null;
        if (!closed) options.onDisconnect();
      },
    },
  });

  return {
    bootstrapEnv: {
      [RUNNER_CONTROL_PORT_ENV]: String(listener.port),
      [RUNNER_CONTROL_TOKEN_ENV]: token,
    },
    send(message: unknown): boolean {
      if (closed || (authenticatedOnce && !activeSocket)) return false;
      try {
        writer.enqueue(message);
        flush();
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      listener.stop(true);
      for (const socket of connections) socket.terminate();
      connections.clear();
      activeSocket = null;
      writer.clear();
    },
  };
}

export interface RunnerControlClient {
  send(message: unknown): boolean;
  close(): void;
}

export function createRunnerControlClient(options: {
  onMessage(message: unknown): void;
  onError(message: string): void;
  onDisconnect(): void;
  env?: Record<string, string | undefined>;
}): RunnerControlClient | null {
  const childEnv = options.env ?? process.env;
  const rawPort = childEnv[RUNNER_CONTROL_PORT_ENV];
  const token = childEnv[RUNNER_CONTROL_TOKEN_ENV];
  delete childEnv[RUNNER_CONTROL_PORT_ENV];
  delete childEnv[RUNNER_CONTROL_TOKEN_ENV];
  if (!rawPort && !token) return null;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token || token.length < 32) {
    throw new Error("Invalid runner control bootstrap configuration");
  }

  const writer = new RunnerControlFrameWriter();
  writer.enqueue({ type: AUTH_MESSAGE_TYPE, token });
  let socket: Bun.Socket<{ decoder: RunnerControlFrameDecoder }> | null = null;
  let closed = false;
  let unavailable = false;
  let errorReported = false;

  const reportError = (error: unknown): void => {
    if (closed || errorReported) return;
    errorReported = true;
    options.onError(errorMessage(error));
  };
  const fail = (error: unknown): void => {
    reportError(error);
    unavailable = true;
    writer.clear();
  };
  const flush = (): void => {
    if (!socket || closed || unavailable) return;
    try {
      writer.flush(socket);
    } catch (error) {
      fail(error);
      socket.terminate();
    }
  };

  void Bun.connect({
    hostname: "127.0.0.1",
    port,
    data: { decoder: new RunnerControlFrameDecoder() },
    socket: {
      binaryType: "buffer",
      open(connectedSocket) {
        if (closed || unavailable) {
          connectedSocket.terminate();
          return;
        }
        socket = connectedSocket;
        flush();
      },
      data(connectedSocket, data) {
        try {
          for (const message of connectedSocket.data.decoder.push(data)) {
            options.onMessage(message);
          }
        } catch (error) {
          fail(error);
          connectedSocket.terminate();
        }
      },
      drain() {
        flush();
      },
      error(_connectedSocket, error) {
        fail(error);
      },
      connectError(_connectedSocket, error) {
        fail(error);
      },
      close() {
        socket = null;
        if (!closed) {
          unavailable = true;
          writer.clear();
          options.onDisconnect();
        }
      },
    },
  }).catch(fail);

  return {
    send(message: unknown): boolean {
      if (closed || unavailable) return false;
      try {
        writer.enqueue(message);
        flush();
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      unavailable = true;
      writer.clear();
      socket?.end();
      socket = null;
    },
  };
}
