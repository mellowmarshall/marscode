// @effect-diagnostics globalDate:off - Stale-while-revalidate holder for slow native fleet panels (worktrees).

/**
 * Holds the latest value of a slow panel reader. `read` waits for the first load; `peek`
 * never waits. Both return the held value and start one background refresh once it is
 * older than `ttlMs`. A failed load keeps the previous value.
 */
export class FleetCachedPanel<A> {
  private readonly load: () => Promise<A>;
  private readonly ttlMs: number;
  private readonly onUpdate: (value: A) => void;
  private readonly now: () => number;
  private value: A;
  private loadedAt: number | null = null;
  private inFlight: Promise<A> | null = null;

  constructor(options: {
    readonly load: () => Promise<A>;
    readonly ttlMs: number;
    readonly initial: A;
    readonly onUpdate?: ((value: A) => void) | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.load = options.load;
    this.ttlMs = options.ttlMs;
    this.value = options.initial;
    this.onUpdate = options.onUpdate ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  private refresh(): Promise<A> {
    if (this.inFlight) return this.inFlight;
    const run = this.load()
      .then((next) => {
        this.value = next;
        this.loadedAt = this.now();
        this.onUpdate(next);
        return next;
      })
      .catch(() => this.value)
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  async read(): Promise<A> {
    if (this.loadedAt === null) return this.refresh();
    return this.peek();
  }

  /** The held value now; starts a background load when none happened yet or it is stale. */
  peek(): A {
    if (this.loadedAt === null || this.now() - this.loadedAt >= this.ttlMs) void this.refresh();
    return this.value;
  }
}
