import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let envConnected = true;
let rejectAccessOnce = false;
let mockCapabilitiesRes: {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
} = {
  ok: true,
  status: 200,
  data: {
    multiplexedEvents: true,
    canApproveGuards: true,
    guardBrokerListening: true,
    canReadDiagnostics: true,
    tools: { devdeck: true },
  },
};

class FakeEventSource {
  static OPEN = 1;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, Array<(ev: MessageEvent<string>) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListener): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (ev: MessageEvent<string>) => void);
    this.handlers.set(type, list);
  }

  emit(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const handler of this.handlers.get(type) ?? []) {
      handler(ev);
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

vi.mock("./devtoolsClient", () => ({
  hasConnectedEnvironment: () => envConnected,
  subscribeEnvironmentConnected: () => () => {},
  refreshDevtoolsStreamAccess: vi.fn(),
  fetchDevtoolsJson: async () => mockCapabilitiesRes,
  resolveDevtoolsStreamAccessAsync: async () => {
    if (rejectAccessOnce) {
      rejectAccessOnce = false;
      throw new Error("transient access failure");
    }
    return {
      httpBase: "http://127.0.0.1:3773/api/devtools",
      credentials: true,
      query: {},
    };
  },
  buildDevtoolsStreamUrl: (
    access: { httpBase: string },
    subPath: string,
    extraQuery?: Readonly<Record<string, string>>,
  ) => {
    const qs = extraQuery ? new URLSearchParams(extraQuery).toString() : "";
    return `${access.httpBase}${subPath}${qs ? `?${qs}` : ""}`;
  },
}));

describe("devtoolsEventMux", () => {
  const origEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    envConnected = true;
    rejectAccessOnce = false;
    mockCapabilitiesRes = {
      ok: true,
      status: 200,
      data: {
        multiplexedEvents: true,
        canApproveGuards: true,
        guardBrokerListening: true,
        canReadDiagnostics: true,
        tools: { devdeck: true },
      },
    };
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = origEventSource;
  });

  it("coalesces guards, jobs, and devdeck:passive onto ONE EventSource, reconnects on 0->1 topic remount, and upgrades active cleanly", async () => {
    const { subscribeMuxTopic } = await import("./devtoolsEventMux");
    const envId = "mux-env-1" as EnvironmentId;
    const guardEvents: string[] = [];
    const jobEvents: string[] = [];
    const devdeckEvents: string[] = [];

    const unsubGuards = subscribeMuxTopic(envId, "guards", {
      onEvent: (name) => guardEvents.push(name),
    });
    const unsubJobs = subscribeMuxTopic(envId, "jobs", {
      onEvent: (name) => jobEvents.push(name),
    });
    const unsubDevdeck = subscribeMuxTopic(envId, "devdeck:passive", {
      onEvent: (name) => devdeckEvents.push(name),
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(FakeEventSource.instances).toHaveLength(1);
    const es1 = FakeEventSource.instances[0]!;
    expect(es1.url).toContain("/api/devtools/events?");
    expect(es1.url).toContain("topics=devdeck%2Cguards%2Cjobs");
    expect(es1.url).toContain("passive=1");

    es1.emit("guards:event", { type: "snapshot", pending: [] });
    es1.emit("jobs:snapshot", { jobs: [] });
    es1.emit("devdeck:host", { name: "host-x" });
    expect(guardEvents).toEqual(["event"]);
    expect(jobEvents).toEqual(["snapshot"]);
    expect(devdeckEvents).toEqual(["host"]);

    // Unsubscribing guards and immediately remounting (0 -> 1) MUST reconnect for fresh snapshot
    unsubGuards();
    const unsubGuards2 = subscribeMuxTopic(envId, "guards", {
      onEvent: (name) => guardEvents.push(`remount:${name}`),
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(es1.closed).toBe(true);

    // Upgrading to devdeck:active replaces the single stream with full panels
    const unsubActive = subscribeMuxTopic(envId, "devdeck:active", {
      onEvent: (name) => devdeckEvents.push(`active:${name}`),
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(FakeEventSource.instances).toHaveLength(3);
    const es3 = FakeEventSource.instances[2]!;
    expect(es3.url).toContain("panels=host%2Cservers");
    expect(es3.url).not.toContain("passive=1");

    // Unsubscribing all closes cleanly
    unsubActive();
    unsubDevdeck();
    unsubJobs();
    unsubGuards2();
    expect(es3.closed).toBe(true);
  });

  it("recovers from rejected access lookup and fires onFallbackNeeded on 404 server downgrade", async () => {
    const { subscribeMuxTopic } = await import("./devtoolsEventMux");
    const envId = "mux-env-2" as EnvironmentId;
    rejectAccessOnce = true;
    const onFallback = vi.fn();

    const unsub = subscribeMuxTopic(envId, "jobs", {
      onEvent: () => {},
      onFallbackNeeded: onFallback,
    });

    // First attempt rejects; backoff retry recovers cleanly instead of bricking the channel
    await vi.advanceTimersByTimeAsync(60);
    expect(FakeEventSource.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Server downgrade (404 on /capabilities) triggers fallback instead of looping forever
    mockCapabilitiesRes = { ok: false, status: 404, data: null };
    FakeEventSource.instances[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(onFallback).toHaveBeenCalledTimes(1);

    unsub();
  });
});
