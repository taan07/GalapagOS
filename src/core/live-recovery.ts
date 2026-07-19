// Project-scoped reconciliation primitives. SSE is an invalidation signal,
// not a durable log: every reconnect recovers from HTTP truth. These small
// browser-safe models make late responses and reconnect storms deterministic.

export type StreamConnectionState = "connecting" | "live" | "reconnecting";

export type ReconciliationTicket = {
  projectId: string;
  generation: number;
};

/**
 * The tab-local owner of a manager POST stream. A project can briefly have two
 * streams: turn N stays open for distillation while turn N+1 has already
 * started. Only the newest one may control the shared live-turn surface.
 */
export type ProjectStreamTicket = {
  projectId: string;
  generation: number;
};

export type ProjectRecoveryModel<T> = {
  select(projectId: string | null): void;
  selected(): string | null;
  begin(projectId: string): ReconciliationTicket;
  mayApply(ticket: ReconciliationTicket): boolean;
  store(ticket: ReconciliationTicket, value: T): boolean;
  cached(projectId: string): T | undefined;
  connection(): StreamConnectionState;
  setConnection(state: StreamConnectionState): void;
};

/** Project-keyed mutable state that must survive navigation without leaking. */
export function createProjectActivityModel<T>() {
  const streams = new Map<string, number>();
  const latestStreamGeneration = new Map<string, number>();
  const queues = new Map<string, T[]>();
  return {
    beginStream(projectId: string): ProjectStreamTicket {
      streams.set(projectId, (streams.get(projectId) ?? 0) + 1);
      const generation = (latestStreamGeneration.get(projectId) ?? 0) + 1;
      latestStreamGeneration.set(projectId, generation);
      return { projectId, generation };
    },
    endStream(ticket: ProjectStreamTicket): number {
      const remaining = Math.max(0, (streams.get(ticket.projectId) ?? 1) - 1);
      if (remaining === 0) streams.delete(ticket.projectId);
      else streams.set(ticket.projectId, remaining);
      return remaining;
    },
    isCurrentStream(ticket: ProjectStreamTicket): boolean {
      return latestStreamGeneration.get(ticket.projectId) === ticket.generation;
    },
    ownsStream(projectId: string): boolean {
      return (streams.get(projectId) ?? 0) > 0;
    },
    queue(projectId: string, initial: () => T[]): T[] {
      const existing = queues.get(projectId);
      if (existing) return existing;
      const value = initial();
      queues.set(projectId, value);
      return value;
    },
    replaceQueue(projectId: string, value: T[]): void {
      queues.set(projectId, value);
    },
  };
}

/**
 * Owns the selected-project generation and a per-project cache. A response
 * may update its own cached snapshot even after navigation, but only the
 * selected project's current generation may affect rendered state.
 */
export function createProjectRecoveryModel<T>(): ProjectRecoveryModel<T> {
  let selectedProjectId: string | null = null;
  let connectionState: StreamConnectionState = "connecting";
  const generations = new Map<string, number>();
  const cache = new Map<string, T>();
  return {
    select(projectId) {
      selectedProjectId = projectId;
    },
    selected() {
      return selectedProjectId;
    },
    begin(projectId) {
      const generation = (generations.get(projectId) ?? 0) + 1;
      generations.set(projectId, generation);
      return { projectId, generation };
    },
    mayApply(ticket) {
      return (
        selectedProjectId === ticket.projectId &&
        generations.get(ticket.projectId) === ticket.generation
      );
    },
    store(ticket, value) {
      if (generations.get(ticket.projectId) !== ticket.generation) {
        return false;
      }
      cache.set(ticket.projectId, value);
      return true;
    },
    cached(projectId) {
      return cache.get(projectId);
    },
    connection() {
      return connectionState;
    },
    setConnection(state) {
      connectionState = state;
    },
  };
}

/** One reconciliation per project at a time; trigger bursts share its work. */
export function createSingleFlightReconciler() {
  type Flight = {
    promise: Promise<void>;
    work: () => Promise<void>;
    started: boolean;
    rerun: boolean;
  };
  const inFlight = new Map<string, Flight>();
  return {
    run(projectId: string, work: () => Promise<void>): Promise<void> {
      const existing = inFlight.get(projectId);
      if (existing) {
        existing.work = work;
        // Calls in the same synchronous burst share the first run. A trigger
        // that arrives after I/O started requests exactly one trailing pass,
        // so reconnect cannot be swallowed by an older pre-sleep fetch.
        if (existing.started) existing.rerun = true;
        return existing.promise;
      }
      const flight = {
        promise: Promise.resolve(),
        work,
        started: false,
        rerun: false,
      } as Flight;
      flight.promise = Promise.resolve()
        .then(async () => {
          flight.started = true;
          do {
            flight.rerun = false;
            await flight.work();
          } while (flight.rerun);
        })
        .finally(() => {
          if (inFlight.get(projectId) === flight) {
            inFlight.delete(projectId);
          }
        });
      inFlight.set(projectId, flight);
      return flight.promise;
    },
    pending(projectId: string): boolean {
      return inFlight.has(projectId);
    },
  };
}
