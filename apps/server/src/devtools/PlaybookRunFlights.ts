/**
 * Single-flight runs for the playbook routes: one run per key, shared by every caller asking
 * for it; aborted (killing its child processes) when its timeout passes or its last caller
 * leaves; at most `maxConcurrent` distinct runs at once.
 */
export type FlightResult<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "busy" }
  | { readonly kind: "aborted" };

interface Flight<T> {
  readonly controller: AbortController;
  readonly promise: Promise<FlightResult<T>>;
  waiters: number;
}

export class PlaybookRunFlights<T> {
  private readonly flights = new Map<string, Flight<T>>();

  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(timeoutMs: number, maxConcurrent: number) {
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
  }

  get size(): number {
    return this.flights.size;
  }

  run(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<FlightResult<T>> {
    let flight = this.flights.get(key);
    if (!flight) {
      if (this.flights.size >= this.maxConcurrent) return Promise.resolve({ kind: "busy" });
      flight = this.launch(key, start);
    }
    const joined = flight;
    joined.waiters += 1;
    if (!callerSignal) return joined.promise;
    return new Promise((resolve) => {
      const leave = () => {
        joined.waiters -= 1;
        if (joined.waiters <= 0) joined.controller.abort(new Error("every caller left"));
        resolve({ kind: "aborted" });
      };
      if (callerSignal.aborted) return leave();
      callerSignal.addEventListener("abort", leave, { once: true });
      void joined.promise.then((result) => {
        callerSignal.removeEventListener("abort", leave);
        resolve(result);
      });
    });
  }

  private launch(key: string, start: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const onTimeout = () => controller.abort(new Error("timed out"));
    timeout.addEventListener("abort", onTimeout, { once: true });
    const promise = start(controller.signal)
      .then((value): FlightResult<T> => {
        if (timeout.aborted) return { kind: "timeout" };
        return controller.signal.aborted ? { kind: "aborted" } : { kind: "done", value };
      })
      .catch((): FlightResult<T> => (timeout.aborted ? { kind: "timeout" } : { kind: "aborted" }))
      .finally(() => {
        timeout.removeEventListener("abort", onTimeout);
        this.flights.delete(key);
      });
    const flight: Flight<T> = { controller, promise, waiters: 0 };
    this.flights.set(key, flight);
    return flight;
  }
}
