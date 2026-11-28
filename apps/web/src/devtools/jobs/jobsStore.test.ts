import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let envConnected = true;
let jobsEndpointStatus = 200;
const envConnListeners = new Map<string, Set<(connected: boolean) => void>>();
const capturedListeners: Array<{
  readonly unsub: () => void;
  readonly spy: ReturnType<typeof vi.fn>;
}> = [];

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

let activeSpy: (() => void) | null = null;

vi.mock("react", () => ({
  useEffect: () => {},
  useRef: <T>(initial: T) => ({ current: initial }),
  useState: <T>(initial: T) => [
    typeof initial === "function" ? (initial as () => T)() : initial,
    () => {},
  ],
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T => {
    const spy = activeSpy ?? vi.fn<() => void>();
    const unsub = subscribe(spy);
    capturedListeners.push({ unsub, spy: spy as ReturnType<typeof vi.fn> });
    return getSnapshot();
  },
}));

let mockNotificationMode: "off" | "sound" | "notifications" | "notifications-and-sound" = "off";
const playNotificationSoundSpy = vi.fn<
  (kind: "completion" | "input", shouldPlay: () => boolean) => Promise<void>
>(() => Promise.resolve());

vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ notificationMode: mockNotificationMode }),
}));

vi.mock("../../threadNotifications", () => ({
  hasDesktopNotifications: (mode: string) =>
    mode === "notifications" || mode === "notifications-and-sound",
  hasNotificationSound: (mode: string) => mode === "sound" || mode === "notifications-and-sound",
  playNotificationSound: (kind: "completion" | "input", shouldPlay: () => boolean) =>
    playNotificationSoundSpy(kind, shouldPlay),
}));

vi.mock("../devtoolsStreams", () => ({
  ensureCapabilities: async () => ({
    capabilities: {
      host: "test-host",
      platform: "linux",
      guardBrokerListening: true,
      canReadDiagnostics: true,
      tools: { devdeck: true, shipQueue: true, playbook: true, reaper: true },
    },
    unsupported: false,
    checked: true,
  }),
}));

vi.mock("../devtoolsClient", () => ({
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
          tools: { devdeck: true, shipQueue: true, playbook: true, reaper: true },
        },
      };
    }
    if (subPath === "/jobs" || subPath === "/jobs?refresh=1") {
      return { ok: jobsEndpointStatus === 200, status: jobsEndpointStatus, data: { jobs: [] } };
    }
    if (subPath === "/ship-queue/status") {
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          data: {
            jobs: [
              {
                id: "99",
                repo: "devtools",
                branch: "feat/legacy-refresh",
                state: "running",
                submitted_at: "2026-11-21T10:05:00Z",
              },
            ],
            open_count: 1,
          },
        },
      };
    }
    return { ok: false, status: 404 };
  },
  resolveDevtoolsStreamAccessAsync: async () => ({
    baseUrl: "http://127.0.0.1:3773",
    wsTicket: "test-ticket",
    credentials: false,
  }),
  refreshDevtoolsStreamAccess: () => {},
  buildDevtoolsStreamUrl: (access: { baseUrl: string }, subPath: string) =>
    `${access.baseUrl}/api/devtools${subPath}`,
}));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("jobsStore O(1) isolation, 404 fallback, and recovery", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    envConnected = true;
    jobsEndpointStatus = 200;
    mockNotificationMode = "off";
    playNotificationSoundSpy.mockClear();
    envConnListeners.clear();
    FakeEventSource.instances = [];
    capturedListeners.length = 0;
    activeSpy = null;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(async () => {
    while (capturedListeners.length > 0) {
      capturedListeners.pop()!.unsub();
    }
    const store = await import("./jobsStore");
    store._resetJobsStoreForTests();
    globalThis.EventSource = originalEventSource;
  });

  it("notifies only the owning thread and progress leaf on upsert (0 calls to unrelated sidebar rows)", async () => {
    const store = await import("./jobsStore");
    const envId = "env-isolation" as EnvironmentId;

    const spyThreadA = vi.fn();
    activeSpy = spyThreadA;
    store.useThreadJobStatus({
      environmentId: envId,
      threadId: "thread-A",
      branch: "feat/a",
      worktreePath: "/wt/a",
      gitCwd: "/repo",
    });

    const spyThreadB = vi.fn();
    activeSpy = spyThreadB;
    store.useThreadJobStatus({
      environmentId: envId,
      threadId: "thread-B",
      branch: "feat/b",
      worktreePath: "/wt/b",
      gitCwd: "/repo",
    });

    const spyLeafA = vi.fn();
    activeSpy = spyLeafA;
    store.useJobProgressPercent(envId, "bg:0123456789abcdef");
    activeSpy = null;

    await flushMicrotasks();
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain("/api/devtools/jobs/events");

    // Emit upsert targeting thread-A with native source: "background"
    store.applyJobsStreamEvent(envId, "upsert", {
      id: "bg:0123456789abcdef",
      revision: 1,
      source: "background",
      kind: "render",
      title: "Render test A",
      phaseLabel: "Rendering",
      state: "running",
      binding: { threadId: "thread-A", host: "host-c" },
      timing: { startedAt: "2026-11-21T10:00:00Z" },
      progress: { current: 50, total: 100, fraction: 0.5 },
      cancellable: true,
    });

    expect(spyThreadA).toHaveBeenCalledTimes(1);
    expect(spyLeafA).toHaveBeenCalledTimes(1);
    expect(spyThreadB).toHaveBeenCalledTimes(0);

    // Compact sidebar status must use short kind label ("Render") and preserve source: "background"
    const statusA = store.useThreadJobStatus({
      environmentId: envId,
      threadId: "thread-A",
      branch: "feat/a",
      worktreePath: "/wt/a",
      gitCwd: "/repo",
    });
    expect(statusA?.source).toBe("background");
    expect(statusA?.label).toBe("Render");
    expect(statusA?.hasProgress).toBe(true);

    // Tick progress 5 more times -> thread-B still gets ZERO notifications
    for (let i = 2; i <= 6; i += 1) {
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:0123456789abcdef",
        revision: i,
        source: "background",
        kind: "render",
        title: "Render test A",
        phaseLabel: "Rendering",
        state: "running",
        binding: { threadId: "thread-A", host: "host-c" },
        timing: { startedAt: "2026-11-21T10:00:00Z" },
        progress: { current: 50 + i * 5, total: 100, fraction: (50 + i * 5) / 100 },
        cancellable: true,
      });
    }
    expect(spyThreadB).toHaveBeenCalledTimes(0);
    expect(spyLeafA).toHaveBeenCalledTimes(6);

    // A ship-queue job waiting on challenge hold resolves to phase "hold" with label "On hold"
    store.applyJobsStreamEvent(envId, "upsert", {
      id: "ship:404",
      revision: 1,
      source: "ship-queue",
      kind: "ship",
      title: "feat: review hold",
      phaseLabel: "On hold",
      state: "waiting",
      binding: { threadId: "thread-B", host: "host-a" },
      timing: { startedAt: "2026-11-21T10:05:00Z" },
      cancellable: true,
      shipJob: { id: "404", state: "waiting", waiting_for: "challenge" },
    });
    const statusB = store.useThreadJobStatus({
      environmentId: envId,
      threadId: "thread-B",
      branch: "feat/b",
      worktreePath: "/wt/b",
      gitCwd: "/repo",
    });
    expect(statusB).toMatchObject({
      jobId: "ship:404",
      source: "ship-queue",
      phase: "hold",
      label: "On hold",
    });
  });

  it("falls back to /ship-queue/events when a linked peer returns 404 on /jobs and recovers after disconnect", async () => {
    const store = await import("./jobsStore");
    const envId = "env-legacy" as EnvironmentId;
    jobsEndpointStatus = 404;

    store.useSharedJobs(envId);
    await flushMicrotasks();

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain("/api/devtools/jobs/events");

    // Simulate 404 stream failure before open -> should probe /jobs (404) and switch to /ship-queue/events
    FakeEventSource.instances[0]!.onerror?.();
    await flushMicrotasks();

    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]?.url).toContain("/api/devtools/ship-queue/events");

    FakeEventSource.instances[1]!.onopen?.();
    FakeEventSource.instances[1]!.emit("snapshot", {
      jobs: [
        {
          id: "42",
          repo: "devtools",
          branch: "feat/x",
          state: "running",
          submitted_at: "2026-11-21T10:00:00Z",
        },
      ],
      open_count: 1,
    });

    const snap = store.useSharedJobs(envId);
    expect(snap.live).toBe(true);
    expect(snap.legacyFallback).toBe(true);
    expect(snap.jobs.length).toBe(1);
    expect(snap.jobs[0]?.id).toBe("ship:42");

    // Offline -> legacy refresh unwraps { ok, data } without falsely setting live: true
    setMockConnected(envId, false);
    expect(store.useSharedJobs(envId).live).toBe(false);
    await store.refreshSharedJobs(envId);
    const refreshedOffline = store.useSharedJobs(envId);
    expect(refreshedOffline.live).toBe(false);
    expect(refreshedOffline.jobs.map((j) => j.id)).toEqual(["ship:99"]);

    // Online reconnects cleanly
    setMockConnected(envId, true);
    await flushMicrotasks();
    expect(FakeEventSource.instances.length).toBe(3);
  });

  it("restricts unfocused job alerts to train/render/eval anomalies and deduplicates stalls and metric divergence", async () => {
    const store = await import("./jobsStore");
    const envId = "env-unfocused-notify" as EnvironmentId;
    mockNotificationMode = "sound";

    const originalDocument = globalThis.document;
    globalThis.document = {
      hidden: true,
      hasFocus: () => false,
    } as unknown as Document;

    try {
      store.useSharedJobs(envId);
      await flushMicrotasks();

      // Routine command/build/test jobs never alert on completion, failure, stall, or nan text
      for (const kind of ["command", "build", "test"] as const) {
        store.applyJobsStreamEvent(envId, "upsert", {
          id: `bg:routine-${kind}`,
          revision: 1,
          source: "background",
          kind,
          title: `run ${kind}`,
          phaseLabel: "Running",
          state: "running",
          anomaly: "No output for 15m",
          binding: { threadId: "thread-1", host: "host-c" },
          timing: { startedAt: "2026-11-22T10:00:00Z" },
          cancellable: true,
        });
        store.applyJobsStreamEvent(envId, "upsert", {
          id: `bg:routine-${kind}`,
          revision: 2,
          source: "background",
          kind,
          title: `run ${kind}`,
          phaseLabel: "Running",
          state: "running",
          anomaly: "loss=nan",
          binding: { threadId: "thread-1", host: "host-c" },
          timing: { startedAt: "2026-11-22T10:00:00Z" },
          cancellable: true,
        });
        store.applyJobsStreamEvent(envId, "upsert", {
          id: `bg:routine-${kind}`,
          revision: 3,
          source: "background",
          kind,
          title: `run ${kind}`,
          phaseLabel: "Failed",
          state: "failed",
          binding: { threadId: "thread-1", host: "host-c" },
          timing: { startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:16:00Z" },
          cancellable: false,
        });
      }
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(0);

      // Misclassified render/eval job without an attached log, metrics, or progress does not alert
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:guessed-render-vitest",
        revision: 1,
        source: "background",
        kind: "render",
        title: "pnpm vitest run src/render.test.ts",
        phaseLabel: "Running",
        state: "running",
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:01:00Z" },
        cancellable: true,
      });
      // Remote job whose log is unavailable cannot be judged stalled
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:remote-train",
        revision: 1,
        source: "background",
        kind: "train",
        title: "ssh gpu train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "remote_unavailable",
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "gpu-box" },
        timing: { startedAt: "2026-11-22T10:01:00Z" },
        cancellable: true,
      });
      // Train job without extracted metrics ignores stray nan text
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-no-metrics",
        revision: 1,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: false,
        anomaly: "loss=nan",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:01:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(0);

      // Train job with attached log alerts once even as minutes tick up or after transient output clears it
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 1,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 2,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        anomaly: "No output for 16m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 3,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 4,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(1);
      expect(playNotificationSoundSpy).toHaveBeenCalledWith("input", expect.any(Function));

      // Metric divergence on train with metrics alerts once even if alternating nan/inf keys appear
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 5,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        anomaly: "loss=nan",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:train-1",
        revision: 6,
        source: "background",
        kind: "train",
        title: "train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        hasMetrics: true,
        anomaly: "grad=inf",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:02:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(2);

      // Render job with progress alerts on stall, but ignores nan/inf metric tokens and terminal upserts
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:render-1",
        revision: 1,
        source: "background",
        kind: "render",
        title: "blender scene.blend",
        phaseLabel: "Rendering",
        state: "running",
        progress: { current: 10, total: 100, fraction: 0.1 },
        hasMetrics: true,
        anomaly: "frame=nan",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:03:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(2);

      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:render-1",
        revision: 2,
        source: "background",
        kind: "render",
        title: "blender scene.blend",
        phaseLabel: "Rendering",
        state: "running",
        progress: { current: 10, total: 100, fraction: 0.1 },
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:03:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(3);

      // Snapshot reconnect already showing a stall does not re-alert when the minute counter increments
      store.applyJobsStreamEvent(envId, "snapshot", {
        jobs: [
          {
            id: "bg:reconnected-eval",
            revision: 10,
            source: "background",
            kind: "eval",
            title: "eval.py",
            phaseLabel: "Running",
            state: "running",
            logState: "attached",
            anomaly: "No output for 20m",
            binding: { threadId: "thread-1", host: "host-c" },
            timing: { startedAt: "2026-11-22T10:00:00Z" },
            cancellable: true,
          },
        ],
      });
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:reconnected-eval",
        revision: 11,
        source: "background",
        kind: "eval",
        title: "eval.py",
        phaseLabel: "Running",
        state: "running",
        logState: "attached",
        anomaly: "No output for 21m",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:00:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(3);

      // Terminal job carrying a lingering anomaly does not alert
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:terminal-train",
        revision: 1,
        source: "background",
        kind: "train",
        title: "train2.py",
        phaseLabel: "Failed",
        state: "failed",
        logState: "attached",
        hasMetrics: true,
        anomaly: "loss=nan",
        binding: { threadId: "thread-1", host: "host-c" },
        timing: { startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:05:00Z" },
        cancellable: false,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(3);

      // Remote GPU training job streaming metrics over SSH still alerts once on stall
      store.applyJobsStreamEvent(envId, "upsert", {
        id: "bg:remote-train-with-metrics",
        revision: 1,
        source: "background",
        kind: "train",
        title: "ssh gpu train.py",
        phaseLabel: "Running",
        state: "running",
        logState: "remote_unavailable",
        hasMetrics: true,
        anomaly: "No output for 15m",
        binding: { threadId: "thread-1", host: "gpu-box" },
        timing: { startedAt: "2026-11-22T10:00:00Z" },
        cancellable: true,
      });
      expect(playNotificationSoundSpy).toHaveBeenCalledTimes(4);
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
