// @effect-diagnostics globalTimers:off - Serialized startup hydration, reconnect/stall reconcile scheduler, and domain-event reconnect loop.
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { BackgroundLifecycleContext } from "./BackgroundTaskLifecycle.ts";
import { nowMonotonicMs } from "./managedJobHelpers.ts";

const RECONCILE_RETRY_MAX_MS = 60_000;

export interface SnapshotReconcileResult {
  readonly partial: boolean;
}

/**
 * Serializes startup hydration, reconnect reconciles, and stall reconciles with bounded backoff
 * retries on failure or partial command-lookup failures, deferred cooldown triggers, and zero overlap.
 */
export class BackgroundReconcileScheduler {
  private readonly opts: {
    readonly stallCooldownMs: number;
    readonly retryBaseMs: number;
    readonly isDisposed: () => boolean;
    readonly hydrationFence: BackgroundLifecycleContext["hydrationFence"];
    readonly runSnapshot: (reconcile: boolean) => Promise<SnapshotReconcileResult>;
  };
  private activePromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stallCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs: number;
  private initialHydrated = false;
  private queued = false;
  private lastStallReconcileAtMs = -Infinity;

  constructor(opts: {
    readonly stallCooldownMs: number;
    readonly retryBaseMs: number;
    readonly isDisposed: () => boolean;
    readonly hydrationFence: BackgroundLifecycleContext["hydrationFence"];
    readonly runSnapshot: (reconcile: boolean) => Promise<SnapshotReconcileResult>;
  }) {
    this.opts = opts;
    this.retryDelayMs = opts.retryBaseMs;
  }

  ensureHydrated(): Promise<void> {
    if (this.initialHydrated) return Promise.resolve();
    if (this.activePromise) return this.activePromise;
    if (!this.opts.hydrationFence.canAttemptHydration(nowMonotonicMs())) return Promise.resolve();
    return this.run(false);
  }

  requestReconcile(): void {
    if (this.opts.isDisposed()) return;
    if (this.stallCooldownTimer !== null) {
      clearTimeout(this.stallCooldownTimer);
      this.stallCooldownTimer = null;
    }
    if (this.activePromise) {
      this.queued = true;
      return;
    }
    void this.run(true);
  }

  triggerStallReconcile(): boolean {
    if (this.opts.isDisposed()) return false;
    if (this.activePromise) {
      this.queued = true;
      return true;
    }
    const nowMs = nowMonotonicMs();
    const elapsed = nowMs - this.lastStallReconcileAtMs;
    if (elapsed < this.opts.stallCooldownMs) {
      // Defer to the end of the cooldown so a second stalling job is never dropped.
      if (this.stallCooldownTimer === null) {
        const remainingMs = Math.max(1, Math.ceil(this.opts.stallCooldownMs - elapsed));
        this.stallCooldownTimer = setTimeout(() => {
          this.stallCooldownTimer = null;
          if (!this.opts.isDisposed()) {
            this.lastStallReconcileAtMs = nowMonotonicMs();
            this.requestReconcile();
          }
        }, remainingMs);
        this.stallCooldownTimer.unref();
      }
      return true;
    }
    this.lastStallReconcileAtMs = nowMs;
    this.requestReconcile();
    return true;
  }

  scheduleRetryForPartial(): void {
    this.scheduleRetry();
  }

  dispose(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.stallCooldownTimer !== null) {
      clearTimeout(this.stallCooldownTimer);
      this.stallCooldownTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.opts.isDisposed() || this.retryTimer !== null) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(RECONCILE_RETRY_MAX_MS, Math.round(delay * 2));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.opts.isDisposed()) {
        if (this.initialHydrated) {
          this.requestReconcile();
        } else {
          void this.run(false);
        }
      }
    }, delay);
    this.retryTimer.unref();
  }

  private run(reconcile: boolean): Promise<void> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (reconcile) this.opts.hydrationFence.resetForReconnect();
    const run = this.opts
      .runSnapshot(reconcile)
      .then((res) => {
        this.initialHydrated = true;
        if (res.partial) {
          this.scheduleRetry();
        } else {
          this.retryDelayMs = this.opts.retryBaseMs;
        }
      })
      .catch(() => {
        this.opts.hydrationFence.markHydrationFailed(nowMonotonicMs());
        this.scheduleRetry();
      })
      .finally(() => {
        this.activePromise = null;
        if (this.queued && !this.opts.isDisposed()) {
          this.queued = false;
          this.requestReconcile();
        }
      });
    this.activePromise = run;
    return run;
  }
}

export function forkDomainEventReconnectLoop(opts: {
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, unknown>;
  readonly reconnectDelayMs: number;
  readonly isDisposed: () => boolean;
  readonly onReconnect: () => void;
  readonly onEvent: (event: OrchestrationV2DomainEvent) => void;
}): Fiber.Fiber<void, unknown> {
  return Effect.runFork(
    Effect.gen(function* () {
      let attempt = 0;
      while (!opts.isDisposed()) {
        const isReconnect = attempt > 0;
        attempt += 1;
        if (isReconnect) {
          queueMicrotask(() => {
            if (!opts.isDisposed()) opts.onReconnect();
          });
        }
        yield* opts.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (!opts.isDisposed()) opts.onEvent(event);
            }),
          ),
          Effect.ignore,
        );
        if (opts.isDisposed()) break;
        yield* Effect.sleep(Duration.millis(opts.reconnectDelayMs));
      }
    }),
  );
}
