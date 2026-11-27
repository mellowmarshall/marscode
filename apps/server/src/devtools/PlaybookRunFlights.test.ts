import { describe, expect, it } from "@effect/vitest";

import { PlaybookRunFlights } from "./PlaybookRunFlights.ts";

/** A run that settles only when told to, or rejects when its signal aborts. */
function controllable() {
  const signals: AbortSignal[] = [];
  let finish: (value: string) => void = () => {};
  const start = (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { signals, start, finish: (value: string) => finish(value) };
}

describe("PlaybookRunFlights", () => {
  it("shares one run between callers of the same key", async () => {
    const flights = new PlaybookRunFlights<string>(60_000, 4);
    const run = controllable();
    const first = flights.run("repo", run.start, new AbortController().signal);
    const second = flights.run("repo", run.start, new AbortController().signal);
    expect(run.signals).toHaveLength(1);
    run.finish("report");
    expect(await first).toEqual({ kind: "done", value: "report" });
    expect(await second).toEqual({ kind: "done", value: "report" });
    expect(flights.size).toBe(0);
  });

  it("aborts the run only when its last caller leaves", async () => {
    const flights = new PlaybookRunFlights<string>(60_000, 4);
    const run = controllable();
    const a = new AbortController();
    const b = new AbortController();
    const first = flights.run("repo", run.start, a.signal);
    const second = flights.run("repo", run.start, b.signal);
    a.abort();
    expect(await first).toEqual({ kind: "aborted" });
    expect(run.signals[0]?.aborted).toBe(false);
    b.abort();
    expect(await second).toEqual({ kind: "aborted" });
    expect(run.signals[0]?.aborted).toBe(true);
  });

  it("aborts a run past its timeout and reports it", async () => {
    const flights = new PlaybookRunFlights<string>(1, 4);
    const run = controllable();
    expect(await flights.run("repo", run.start)).toEqual({ kind: "timeout" });
    expect(run.signals[0]?.aborted).toBe(true);
  });

  it("refuses a new key past the concurrency bound", async () => {
    const flights = new PlaybookRunFlights<string>(60_000, 1);
    const run = controllable();
    const held = flights.run("one", run.start);
    expect(await flights.run("two", run.start)).toEqual({ kind: "busy" });
    run.finish("ok");
    expect(await held).toEqual({ kind: "done", value: "ok" });
  });
});
