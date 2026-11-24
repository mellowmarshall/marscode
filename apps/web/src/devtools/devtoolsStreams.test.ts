import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let envConnected = false;
const envConnListeners = new Map<string, Set<(connected: boolean) => void>>();
const capturedSubscribes: Array<() => void> = [];

function setMockConnected(envId: string, connected: boolean): void {
  envConnected = connected;
  for (const listener of envConnListeners.get(envId) ?? []) {
    listener(connected);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
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
  }
}

vi.mock("react", () => ({
  useEffect: () => {},
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T => {
    const unsub = subscribe(() => {});
    capturedSubscribes.push(unsub);
    return getSnapshot();
  },
}));

vi.mock("./devtoolsClient", () => ({
  hasConnectedEnvironment: () => envConnected,
  subscribeEnvironmentConnected: (envId: string, listener: (connected: boolean) => void) => {
    let set = envConnListeners.get(envId);
    if (!set) {
      set = new Set();
      envConnListeners.set(envId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  },
  fetchDevtoolsJson: async (_envId: string, subPath: string) => {
    if (subPath === "/capabilities") {
      return {
        ok: true,
        status: 200,
        data: {
          host: "test-host",
          platform: "linux",
          guardBrokerListening: true,
          canReadDiagnostics: true,
          devdeckPassiveSupported: true,
          tools: {
            devdeck: true,
            shipQueue: true,
            playbook: true,
            devlease: true,
            reaper: true,
          },
        },
      };
    }
    return { ok: true, status: 200, data: { ok: true, data: { jobs: [] } } };
  },
  resolveDevtoolsStreamAccessAsync: async () => ({
    httpBase: "http://127.0.0.1:3773/api/devtools",
    credentials: true,
    query: {},
  }),
  buildDevtoolsStreamUrl: (access: { httpBase: string }, subPath: string) =>
    `${access.httpBase}${subPath}`,
  refreshDevtoolsStreamAccess: () => {},
}));

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("devtoolsStreams connection recovery", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    envConnected = false;
    envConnListeners.clear();
    capturedSubscribes.length = 0;
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource;
  });

  afterEach(() => {
    for (const unsub of capturedSubscribes) unsub();
    capturedSubscribes.length = 0;
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      originalEventSource;
  });

  it("recovers Ship Queue SSE after a pre-connect startup subscription and across disconnect/reconnect", async () => {
    vi.resetModules();
    const streams = await import("./devtoolsStreams");
    const envId = "env-startup-race" as EnvironmentId;

    // 1. Sidebar row subscribes during app boot BEFORE the environment connects.
    const initial = streams.useSharedShipQueueSelector(envId, (s) => s);
    expect(initial.live).toBe(false);
    expect(initial.error).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);

    // 2. Environment finishes connecting -> watcher automatically opens Ship Queue SSE.
    setMockConnected(envId, true);
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);
    const es1 = FakeEventSource.instances[0]!;
    expect(es1.url).toContain("/ship-queue/events");
    es1.onopen?.();
    es1.emit("snapshot", {
      open_count: 1,
      total_count: 1,
      jobs: [{ id: "100", state: "running" }],
    });

    const liveSnap = streams.useSharedShipQueue(envId);
    expect(liveSnap.live).toBe(true);
    expect(liveSnap.error).toBeNull();
    expect(liveSnap.payload?.jobs).toHaveLength(1);

    // 3. Environment disconnects -> closes SSE and marks offline; reconnect clears error and opens SSE.
    setMockConnected(envId, false);
    expect(es1.closed).toBe(true);
    const offlineSnap = streams.useSharedShipQueue(envId);
    expect(offlineSnap.live).toBe(false);
    expect(offlineSnap.error).toBeTruthy();

    setMockConnected(envId, true);
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(2);
    const es2 = FakeEventSource.instances[1]!;
    es2.onopen?.();
    const recoveredSnap = streams.useSharedShipQueue(envId);
    expect(recoveredSnap.live).toBe(true);
    expect(recoveredSnap.error).toBeNull();
  });
});
