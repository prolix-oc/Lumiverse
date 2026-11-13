import type { IPCMessage } from "../types/operator";
import {
  createRunnerControlClient,
  type RunnerControlClient,
} from "./runner-control-transport";

type MessageHandler = (message: IPCMessage) => void;

const handlers = new Set<MessageHandler>();
let socketChannel: RunnerControlClient | null = null;

function dispatch(message: unknown): void {
  if (!message || typeof message !== "object") return;
  for (const handler of handlers) handler(message as IPCMessage);
}

try {
  socketChannel = createRunnerControlClient({
    onMessage: dispatch,
    onError(message) {
      console.error(`[runner-control] ${message}`);
    },
    onDisconnect() {
      console.warn("[runner-control] Runner control channel disconnected");
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[runner-control] ${message}`);
}

if (!socketChannel && typeof process.send === "function") {
  process.on("message", dispatch);
}

export const runnerChannelAvailable = socketChannel !== null || typeof process.send === "function";

export function onRunnerMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function sendRunnerMessage(message: IPCMessage): boolean {
  if (socketChannel) return socketChannel.send(message);
  if (typeof process.send !== "function") return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}
