import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  DevtoolsConfigPayload,
  DevtoolsHostConfig,
  FleetConfigSnapshot,
} from "./devtoolsClient";

interface FetchCall {
  readonly envId: string;
  readonly subPath: string;
  readonly query: Record<string, string | undefined> | undefined;
}

const fetchCalls: FetchCall[] = [];
let mockFetchImpl: (
  envId: string,
  subPath: string,
  options?: { readonly query?: Record<string, string | undefined> },
) => Promise<{ ok: boolean; status: number; data: unknown; error?: string }> = async () => ({
  ok: false,
  status: 500,
  data: null,
  error: "unconfigured",
});

vi.mock("react", () => ({
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T => {
    const unsub = subscribe(() => {});
    unsub();
    return getSnapshot();
  },
}));

vi.mock("./devtoolsClient", () => ({
  fetchDevtoolsJson: (
    envId: string,
    subPath: string,
    options?: { readonly query?: Record<string, string | undefined> },
  ) => {
    fetchCalls.push({ envId, subPath, query: options?.query });
    return mockFetchImpl(envId, subPath, options);
  },
}));

import {
  _resetFleetConfigStoreForTests,
  checkFleetConfigDrift,
  recordSavedFleetConfig,
  useFleetConfigStore,
  warmFleetConfigInBackground,
} from "./devtoolsFleetConfigStore";

const ENV_ID = "env-test-1" as EnvironmentId;

function makeConfig(timeoutS: number): DevtoolsHostConfig {
  return {
    challenge_timeout_s: timeoutS,
    playbook_challenge: {
      default: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" },
      fallbacks: [],
      min_remaining_pct: 10,
    },
    ship_queue_review: {
      default: { provider: "claudeAgent", model: "claude-fable-5-2", effort: "high" },
      fallbacks: [],
      min_remaining_pct: 10,
    },
    guards: { request_timeout_s: 120, grant_ttl_s: 60 },
    jobs: { default_stall_minutes: 15 },
  };
}

function makeFleetSnapshot(localTimeout: number, remoteTimeout: number): FleetConfigSnapshot {
  const localCfg = makeConfig(localTimeout);
  const remoteCfg = makeConfig(remoteTimeout);
  return {
    configPath: "/home/test/.local/lib/ship-queue/host-config.json",
    localHost: "main-box",
    localConfig: localCfg,
    resolved: {
      playbookChallenge: {
        role: "playbook_challenge",
        selected: {
          provider: "codex",
          model: "gpt-6.2-astra",
          effort: "medium",
          isDefault: true,
          order: 0,
          available: true,
          remainingPct: 80,
          healthy: true,
        },
        candidates: [],
        fallbackUsed: false,
        reason: "default_healthy",
        minRemainingPct: 10,
        usageRemaining: {},
      },
      shipQueueReview: {
        role: "ship_queue_review",
        selected: {
          provider: "claudeAgent",
          model: "claude-fable-5-2",
          effort: "high",
          isDefault: true,
          order: 0,
          available: true,
          remainingPct: 80,
          healthy: true,
        },
        candidates: [],
        fallbackUsed: false,
        reason: "default_healthy",
        minRemainingPct: 10,
        usageRemaining: {},
      },
    },
    hosts: [
      {
        host: { name: "main-box", label: "main-box", ssh: null, local: true, role: "ci" },
        reachable: true,
        exists: true,
        inSyncWithLocal: true,
        configPath: "/home/test/.local/lib/ship-queue/host-config.json",
        config: localCfg,
      },
      {
        host: { name: "worker-1", label: "worker-1", ssh: "worker-1", local: false, role: "ci" },
        reachable: true,
        exists: true,
        inSyncWithLocal: localTimeout === remoteTimeout,
        configPath: "~/.local/lib/ship-queue/host-config.json",
        config: remoteCfg,
      },
    ],
  };
}

function makeLocalPayload(timeoutS: number): DevtoolsConfigPayload {
  const snap = makeFleetSnapshot(timeoutS, timeoutS);
  return {
    configPath: snap.configPath,
    config: snap.localConfig,
    resolved: snap.resolved,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("devtoolsFleetConfigStore", () => {
  const storageMap = new Map<string, string>();

  beforeEach(() => {
    fetchCalls.length = 0;
    storageMap.clear();
    _resetFleetConfigStoreForTests();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          storageMap.set(k, v);
        },
        removeItem: (k: string) => {
          storageMap.delete(k);
        },
      },
    });
  });

  afterEach(() => {
    _resetFleetConfigStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("warms once in the background without showing spinner and persists to localStorage for instant reopen", async () => {
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      data: makeFleetSnapshot(180, 180),
    });

    warmFleetConfigInBackground(ENV_ID);
    warmFleetConfigInBackground(ENV_ID); // deduped
    expect(useFleetConfigStore(ENV_ID).checking).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toEqual({ envId: ENV_ID, subPath: "/config/fleet", query: undefined });

    await flushMicrotasks();
    const warmed = useFleetConfigStore(ENV_ID);
    expect(warmed.fleetSnapshot?.localConfig.challenge_timeout_s).toBe(180);
    expect(warmed.checking).toBe(false);

    // Simulating app restart: reset memory store, keep localStorage -> instant synchronous hydration.
    _resetFleetConfigStoreForTests();
    const rehydrated = useFleetConfigStore(ENV_ID);
    expect(rehydrated.fleetSnapshot?.localConfig.challenge_timeout_s).toBe(180);
    expect(rehydrated.localPayload?.config.challenge_timeout_s).toBe(180);
  });

  it("renders fast local /config immediately on cold boot while /config/fleet checks in background", async () => {
    const fleetDeferred = Promise.withResolvers<{
      ok: boolean;
      status: number;
      data: unknown;
      error?: string;
    }>();
    mockFetchImpl = async (_envId, subPath) => {
      if (subPath === "/config") {
        return { ok: true, status: 200, data: makeLocalPayload(180) };
      }
      return fleetDeferred.promise;
    };

    checkFleetConfigDrift(ENV_ID);
    expect(useFleetConfigStore(ENV_ID).checking).toBe(true);

    await flushMicrotasks();
    // Fast /config already populated localPayload while /config/fleet is still running!
    const midCheck = useFleetConfigStore(ENV_ID);
    expect(midCheck.localPayload?.config.challenge_timeout_s).toBe(180);
    expect(midCheck.fleetSnapshot).toBeNull();
    expect(midCheck.checking).toBe(true);

    fleetDeferred.resolve({ ok: true, status: 200, data: makeFleetSnapshot(180, 240) });
    await flushMicrotasks();

    const settled = useFleetConfigStore(ENV_ID);
    expect(settled.checking).toBe(false);
    expect(settled.fleetSnapshot?.hosts[1]?.inSyncWithLocal).toBe(false);
  });

  it("throttles redundant drift checks within 15s, runs refresh=1 on forceRefresh or after interval, and keeps cached config on drift error", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      data: makeFleetSnapshot(180, 180),
    });

    warmFleetConfigInBackground(ENV_ID);
    await flushMicrotasks();
    expect(fetchCalls).toHaveLength(1);

    // Reopening Settings within 15s of startup warm-up skips redundant SSH check.
    now += 5_000;
    checkFleetConfigDrift(ENV_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(useFleetConfigStore(ENV_ID).checking).toBe(false);

    // Opening Settings after 15s triggers quiet background refresh=1 drift check.
    now += 20_000;
    mockFetchImpl = async () => ({
      ok: false,
      status: 502,
      data: null,
      error: "transient ssh timeout",
    });
    checkFleetConfigDrift(ENV_ID);
    expect(useFleetConfigStore(ENV_ID).checking).toBe(true);
    expect(fetchCalls[1]).toEqual({
      envId: ENV_ID,
      subPath: "/config/fleet",
      query: { refresh: "1" },
    });

    await flushMicrotasks();
    // Cached config remains visible despite transient drift check error.
    const afterErr = useFleetConfigStore(ENV_ID);
    expect(afterErr.checking).toBe(false);
    expect(afterErr.error).toBeNull();
    expect(afterErr.fleetSnapshot?.localConfig.challenge_timeout_s).toBe(180);

    // Explicit save updates cached snapshot immediately and triggers refresh=1 drift check.
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      data: makeFleetSnapshot(300, 300),
    });
    recordSavedFleetConfig(ENV_ID, makeLocalPayload(300));
    expect(useFleetConfigStore(ENV_ID).localPayload?.config.challenge_timeout_s).toBe(300);
    expect(useFleetConfigStore(ENV_ID).fleetSnapshot?.localConfig.challenge_timeout_s).toBe(300);
    expect(useFleetConfigStore(ENV_ID).checking).toBe(true);
    await flushMicrotasks();
    expect(useFleetConfigStore(ENV_ID).checking).toBe(false);
    expect(useFleetConfigStore(ENV_ID).fleetSnapshot?.hosts[1]?.inSyncWithLocal).toBe(true);
  });

  it("updates only targeted remote host on single-host save without corrupting local host, and clears error during cold-boot retry", async () => {
    mockFetchImpl = async () => ({
      ok: true,
      status: 200,
      data: makeFleetSnapshot(180, 240),
    });
    warmFleetConfigInBackground(ENV_ID);
    await flushMicrotasks();

    // Single remote host save updates worker-1 to 300 while keeping local main-box at 180.
    mockFetchImpl = async () => ({
      ok: false,
      status: 502,
      data: null,
      error: "transient follow-up error",
    });
    const remoteSavedCfg = makeConfig(300);
    recordSavedFleetConfig(ENV_ID, {
      ...makeLocalPayload(300),
      ok: true,
      targetHost: "worker-1",
      results: [
        { host: "worker-1", ssh: "worker-1", local: false, ok: true, config: remoteSavedCfg },
      ],
    });
    const afterRemoteSave = useFleetConfigStore(ENV_ID);
    expect(afterRemoteSave.fleetSnapshot?.localConfig.challenge_timeout_s).toBe(180);
    expect(afterRemoteSave.localPayload?.config.challenge_timeout_s).toBe(180);
    expect(afterRemoteSave.fleetSnapshot?.hosts[0]?.config?.challenge_timeout_s).toBe(180);
    expect(afterRemoteSave.fleetSnapshot?.hosts[1]?.config?.challenge_timeout_s).toBe(300);
    expect(afterRemoteSave.fleetSnapshot?.hosts[1]?.inSyncWithLocal).toBe(false);
    await flushMicrotasks();

    // Cold-boot error clears while retrying and re-emits when the same error repeats.
    _resetFleetConfigStoreForTests();
    storageMap.clear();
    mockFetchImpl = async () => ({
      ok: false,
      status: 503,
      data: null,
      error: "HTTP 503",
    });
    checkFleetConfigDrift(ENV_ID);
    await flushMicrotasks();
    expect(useFleetConfigStore(ENV_ID).error).toBe("HTTP 503");

    checkFleetConfigDrift(ENV_ID, { forceRefresh: true });
    expect(useFleetConfigStore(ENV_ID).checking).toBe(true);
    expect(useFleetConfigStore(ENV_ID).error).toBeNull();
    await flushMicrotasks();
    expect(useFleetConfigStore(ENV_ID).checking).toBe(false);
    expect(useFleetConfigStore(ENV_ID).error).toBe("HTTP 503");
  });
});
