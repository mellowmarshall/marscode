// @effect-diagnostics globalTimers:off - Lossless dirty-ID coalesced SSE broadcaster for unified Bounded Jobs.
import type { JobSummary, JobsQueueMeta } from "./types.ts";

const SSE_COALESCE_MS = 1_000;
const SSE_HEARTBEAT_MS = 20_000;
const ENCODER = new TextEncoder();

interface SseClientState {
  readonly dirtyJobIds: Set<string>;
  readonly removedJobIds: Set<string>;
  readonly includeCmdline: boolean;
  queueMetaDirty: boolean;
  readyToFlush: boolean;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  wakePull: (() => void) | null;
  closed: boolean;
}

export interface JobEventBroadcasterHooks {
  readonly ensureLoaded: () => Promise<void>;
  readonly getInitialSnapshot: (includeCmdline: boolean) => {
    readonly jobs: ReadonlyArray<JobSummary>;
    readonly queueMeta: JobsQueueMeta;
  };
  readonly getSummaryById: (id: string, includeCmdline: boolean) => JobSummary | undefined;
  readonly getQueueMeta: () => JobsQueueMeta;
  readonly onFirstSubscriber: () => void;
  readonly onLastSubscriberGone: () => void;
}

/**
 * Lossless per-connection dirty-ID SSE broadcaster.
 * If a reader stalls across hundreds of updates, IDs coalesce in a Set and drain
 * the latest summary per ID — zero dropped deltas and zero unbounded buffer growth.
 */
export class JobEventBroadcaster {
  private readonly clients = new Set<SseClientState>();
  private readonly hooks: JobEventBroadcasterHooks;

  constructor(hooks: JobEventBroadcasterHooks) {
    this.hooks = hooks;
  }

  get subscriberCount(): number {
    return this.clients.size;
  }

  private wakeClient(client: SseClientState): void {
    if (client.closed) return;
    client.readyToFlush = true;
    if (client.coalesceTimer !== null) {
      clearTimeout(client.coalesceTimer);
      client.coalesceTimer = null;
    }
    const fn = client.wakePull;
    client.wakePull = null;
    if (fn) fn();
  }

  markDirty(jobId: string, urgent: boolean): void {
    for (const client of this.clients) {
      if (client.closed) continue;
      client.removedJobIds.delete(jobId);
      client.dirtyJobIds.add(jobId);
      if (urgent) {
        this.wakeClient(client);
      } else if (client.coalesceTimer === null) {
        client.coalesceTimer = setTimeout(() => {
          client.coalesceTimer = null;
          this.wakeClient(client);
        }, SSE_COALESCE_MS);
        client.coalesceTimer.unref();
      }
    }
  }

  markRemoved(jobId: string): void {
    for (const client of this.clients) {
      if (client.closed) continue;
      client.dirtyJobIds.delete(jobId);
      client.removedJobIds.add(jobId);
      this.wakeClient(client);
    }
  }

  markMetaDirty(): void {
    for (const client of this.clients) {
      if (client.closed) continue;
      client.queueMetaDirty = true;
      this.wakeClient(client);
    }
  }

  createStream(
    signal: AbortSignal,
    options?: { readonly includeCmdline?: boolean | undefined },
  ): ReadableStream<Uint8Array> {
    const client: SseClientState = {
      dirtyJobIds: new Set(),
      removedJobIds: new Set(),
      includeCmdline: options?.includeCmdline !== false,
      queueMetaDirty: false,
      readyToFlush: false,
      coalesceTimer: null,
      wakePull: null,
      closed: false,
    };

    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      if (client.coalesceTimer !== null) {
        clearTimeout(client.coalesceTimer);
        client.coalesceTimer = null;
      }
      const deleted = this.clients.delete(client);
      if (deleted && this.clients.size === 0) {
        this.hooks.onLastSubscriberGone();
      }
      const wake = client.wakePull;
      client.wakePull = null;
      if (wake) wake();
    };

    signal.addEventListener("abort", cleanup, { once: true });

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        if (signal.aborted) {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }
        await this.hooks.ensureLoaded();
        if (signal.aborted || client.closed) {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }
        const wasEmpty = this.clients.size === 0;
        this.clients.add(client);
        if (wasEmpty) {
          this.hooks.onFirstSubscriber();
        }
        const snap = this.hooks.getInitialSnapshot(client.includeCmdline);
        const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
        try {
          controller.enqueue(ENCODER.encode(frame));
        } catch {
          cleanup();
        }
      },
      pull: async (controller) => {
        if (client.closed || signal.aborted) {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }
        const hasPending =
          client.dirtyJobIds.size > 0 || client.removedJobIds.size > 0 || client.queueMetaDirty;
        if (!hasPending || !client.readyToFlush) {
          await new Promise<void>((resolve) => {
            const hb = setTimeout(() => {
              if (client.wakePull === onWake) client.wakePull = null;
              resolve();
            }, SSE_HEARTBEAT_MS);
            hb.unref();
            const onWake = () => {
              clearTimeout(hb);
              resolve();
            };
            client.wakePull = onWake;
          });
        }
        if (client.closed || signal.aborted) {
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }

        client.readyToFlush = false;
        let out = "";
        if (client.dirtyJobIds.size > 0) {
          const ids = [...client.dirtyJobIds];
          client.dirtyJobIds.clear();
          for (const id of ids) {
            const summary = this.hooks.getSummaryById(id, client.includeCmdline);
            if (summary) out += `event: upsert\ndata: ${JSON.stringify(summary)}\n\n`;
          }
        }
        if (client.removedJobIds.size > 0) {
          const ids = [...client.removedJobIds];
          client.removedJobIds.clear();
          for (const id of ids) {
            out += `event: remove\ndata: ${JSON.stringify({ id })}\n\n`;
          }
        }
        if (client.queueMetaDirty) {
          client.queueMetaDirty = false;
          out += `event: meta\ndata: ${JSON.stringify(this.hooks.getQueueMeta())}\n\n`;
        }
        if (!out) out = ": ping\n\n";
        try {
          controller.enqueue(ENCODER.encode(out));
        } catch {
          cleanup();
        }
      },
      cancel() {
        cleanup();
      },
    });
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.closed = true;
      if (client.coalesceTimer !== null) {
        clearTimeout(client.coalesceTimer);
        client.coalesceTimer = null;
      }
      const wake = client.wakePull;
      client.wakePull = null;
      if (wake) wake();
    }
    this.clients.clear();
  }
}
