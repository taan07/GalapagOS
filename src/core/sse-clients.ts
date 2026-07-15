// Transport-only SSE client lifecycle. Heartbeats are comments, deliberately
// outside the daemon event union so browser listeners do no domain work.
export const SSE_HEARTBEAT_MS = 15_000;

export type SseWritable = {
  destroyed?: boolean;
  writableEnded?: boolean;
  write(chunk: string): unknown;
};

type Clock = {
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
};

const systemClock: Clock = { setInterval, clearInterval };

export function createSseClientRegistry(clock: Clock = systemClock) {
  const clients = new Map<SseWritable, ReturnType<typeof setInterval>>();
  const remove = (client: SseWritable) => {
    const timer = clients.get(client);
    if (timer !== undefined) clock.clearInterval(timer);
    clients.delete(client);
  };
  const safeWrite = (client: SseWritable, data: string): boolean => {
    if (client.destroyed || client.writableEnded) {
      remove(client);
      return false;
    }
    try {
      client.write(data);
      return true;
    } catch {
      remove(client);
      return false;
    }
  };
  return {
    add(client: SseWritable): () => void {
      remove(client);
      if (!safeWrite(client, ": heartbeat\n\n")) {
        return () => remove(client);
      }
      const timer = clock.setInterval(() => safeWrite(client, ": heartbeat\n\n"), SSE_HEARTBEAT_MS);
      clients.set(client, timer);
      return () => remove(client);
    },
    broadcast(event: unknown): void {
      for (const client of clients.keys()) safeWrite(client, `data: ${JSON.stringify(event)}\n\n`);
    },
    size(): number {
      return clients.size;
    },
  };
}
