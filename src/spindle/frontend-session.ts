export function readFrontendSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid frontend session identifier');
  return value;
}

export function frontendPresenceKey(authSessionId: string, frontendSessionId?: string): string {
  return frontendSessionId ? `${authSessionId}:${frontendSessionId}` : authSessionId;
}

interface Connection { executionOwner?: boolean; send(value: string): void; close(): void; closed(): void }
const connections = new Map<string, Map<string, Connection>>();

export function registerFrontendSession(userId: string, sessionId: string, connection: Connection): () => void {
  if (readFrontendSessionId(sessionId) !== sessionId) throw new Error('Missing frontend session identifier');
  const sessions = connections.get(userId) ?? new Map<string, Connection>();
  const previous = sessions.get(sessionId);
  sessions.set(sessionId, connection);
  connections.set(userId, sessions);
  previous?.close();
  return () => {
    if (sessions.get(sessionId) !== connection) return;
    sessions.delete(sessionId);
    if (!sessions.size) connections.delete(userId);
    connection.closed();
  };
}

export function sendToFrontendSession(userId: string, sessionId: string, message: unknown): boolean {
  const connection = connections.get(userId)?.get(sessionId);
  if (!connection) return false;
  try { connection.send(JSON.stringify(message)); return true; }
  catch { return false; }
}

export function getActiveFrontendSession(userId: string): string | undefined {
  let active: string | undefined;
  for (const [id, connection] of connections.get(userId) ?? []) {
    if (connection.executionOwner !== false) active = id;
  }
  return active;
}
