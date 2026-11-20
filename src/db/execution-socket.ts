import { timingSafeEqual } from "node:crypto";
import { encodeSubprocessMessage, SubprocessMessageDecoder } from "../utils/subprocess-messages";

const PORT_ENV = "LUMIVERSE_DATABASE_SOCKET_PORT";
const TOKEN_ENV = "LUMIVERSE_DATABASE_SOCKET_TOKEN";
const TOKEN_BYTES = 32;
type MessageSocket = Pick<Bun.Socket, "write" | "flush" | "terminate">;
type SocketState = { auth: Buffer; authOffset: number; decoder: SubprocessMessageDecoder };

/** Retain unwritten bytes until drain, including messages queued before connect. */
class SocketMessages {
  private socket: MessageSocket | null = null;
  private frames: Buffer[] = [];
  private offset = 0;
  private closed = false;

  attach(socket: MessageSocket): void {
    if (this.closed) { socket.terminate(); return; }
    this.socket = socket;
    this.flush();
  }

  write(frame: Buffer): void {
    if (this.closed) throw new Error("Database socket is closed");
    this.frames.push(frame);
    this.flush();
  }

  send(message: unknown): void { this.write(encodeSubprocessMessage(message)); }

  flush(): void {
    if (!this.socket || this.closed) return;
    while (this.frames.length) {
      const frame = this.frames[0]!;
      const written = this.socket.write(frame.subarray(this.offset));
      if (written < 0) throw new Error("Database socket is closed");
      if (written === 0) return;
      this.offset += written;
      if (this.offset === frame.byteLength) { this.frames.shift(); this.offset = 0; }
    }
    this.socket.flush();
  }

  close(): void {
    this.closed = true;
    this.frames = [];
    this.socket?.terminate();
    this.socket = null;
  }
}

interface SocketCallbacks {
  receive(message: unknown): void;
  disconnect(error?: unknown): void;
}

/** A dedicated, authenticated loopback channel; stdout remains diagnostic text. */
export function createDatabaseSocketHost(callbacks: SocketCallbacks) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const messages = new SocketMessages();
  const connections = new Set<Bun.Socket<SocketState>>();
  let active: Bun.Socket<SocketState> | null = null;
  let closed = false;
  const fail = (error?: unknown) => {
    if (closed) return;
    close();
    callbacks.disconnect(error);
  };
  const listener = Bun.listen<SocketState>({
    hostname: "127.0.0.1", port: 0, exclusive: true,
    socket: {
      binaryType: "buffer",
      open(socket) {
        socket.data = { auth: Buffer.alloc(TOKEN_BYTES), authOffset: 0, decoder: new SubprocessMessageDecoder() };
        connections.add(socket);
      },
      data(socket, bytes) {
        try {
          if (active !== socket) {
            const count = Math.min(TOKEN_BYTES - socket.data.authOffset, bytes.byteLength);
            socket.data.auth.set(bytes.subarray(0, count), socket.data.authOffset);
            socket.data.authOffset += count;
            if (socket.data.authOffset !== TOKEN_BYTES) return;
            if (active || !timingSafeEqual(socket.data.auth, token)) { socket.terminate(); return; }
            active = socket;
            listener.stop(false);
            for (const connection of connections) if (connection !== socket) connection.terminate();
            messages.attach(socket);
            bytes = bytes.subarray(count);
          }
          socket.data.decoder.push(bytes, callbacks.receive);
        } catch (error) {
          if (active === socket) fail(error);
          else socket.terminate();
        }
      },
      drain() { try { messages.flush(); } catch (error) { fail(error); } },
      error(socket, error) { if (active === socket) fail(error); },
      close(socket) {
        connections.delete(socket);
        if (active === socket) fail();
      },
    },
  });
  function close(): void {
    if (closed) return;
    closed = true;
    listener.stop(true);
    messages.close();
    for (const socket of connections) socket.terminate();
    connections.clear();
  }
  return {
    env: { [PORT_ENV]: String(listener.port), [TOKEN_ENV]: token.toString("hex") },
    send: (message: unknown) => messages.send(message),
    close,
  };
}

export function createDatabaseSocketClient(callbacks: SocketCallbacks) {
  const rawPort = process.env[PORT_ENV];
  const token = process.env[TOKEN_ENV];
  delete process.env[PORT_ENV];
  delete process.env[TOKEN_ENV];
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid database socket bootstrap configuration");
  }
  const messages = new SocketMessages();
  const decoder = new SubprocessMessageDecoder();
  let closed = false;
  const fail = (error?: unknown) => {
    if (closed) return;
    closed = true;
    messages.close();
    callbacks.disconnect(error);
  };
  // Authenticate before any ready/result frame, even if connect is still pending.
  messages.write(Buffer.from(token, "hex"));
  void Bun.connect({
    hostname: "127.0.0.1", port,
    socket: {
      binaryType: "buffer",
      open(socket) { try { messages.attach(socket); } catch (error) { fail(error); } },
      data(_socket, bytes) { try { decoder.push(bytes, callbacks.receive); } catch (error) { fail(error); } },
      drain() { try { messages.flush(); } catch (error) { fail(error); } },
      error(_socket, error) { fail(error); },
      close() { fail(); },
    },
  }).catch(fail);
  return { send: (message: unknown) => messages.send(message) };
}
