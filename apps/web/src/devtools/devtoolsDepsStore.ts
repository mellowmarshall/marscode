/**
 * Shared, ref-counted per-environment cache for Ship Queue dependency holds (`/ship-queue/deps`).
 * Keeps thread approvals, sidebar indicators, and Ship Queue rows in lockstep without per-thread polling.
 */
import { useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  fetchDevtoolsJson,
  hasConnectedEnvironment,
  subscribeEnvironmentConnected,
  type ShipQueueDepsPayload,
} from "./devtoolsClient";
import { ensureCapabilities } from "./devtoolsStreams";

export interface SharedShipQueueDepsSnapshot {
  readonly payload: ShipQueueDepsPayload | null;
  readonly error: string | null;
  readonly scanningRepos: Readonly<Record<string, string | null>>;
  readonly decidingRepos: Readonly<Record<string, string | null>>;
}

const EMPTY_DEPS: SharedShipQueueDepsSnapshot = {
  payload: null,
  error: null,
  scanningRepos: {},
  decidingRepos: {},
};

const EMPTY_SUBSCRIBE = () => () => {};
const EMPTY_GET = () => EMPTY_DEPS;

const STALE_REVALIDATE_MS = 15_000;
const SCAN_POLL_MS = 5_000;
// A scan runs a Renovate lookup that can take up to 30 minutes; keep polling past that.
const MAX_SCAN_POLL_TICKS = 420;

interface DepsEntry {
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribePassive: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedShipQueueDepsSnapshot;
  snapshot: SharedShipQueueDepsSnapshot;
  listeners: Set<() => void>;
  passiveListeners: Set<() => void>;
  inFlight: AbortController | null;
  lastFetchedMs: number;
  fetchSeq: number;
  scanTimer: ReturnType<typeof setInterval> | null;
  scanTicks: number;
  unsubConnect: (() => void) | null;
}

const entries = new Map<EnvironmentId, DepsEntry>();

export function depScanKey(hold: {
  readonly reportId?: string | null;
  readonly status: string;
  readonly scannedAt?: number | null;
  readonly error?: string | null;
}): string {
  return `${hold.reportId ?? ""}:${hold.status}:${hold.scannedAt ?? ""}:${hold.error ?? ""}`;
}

function getOrCreateEntry(environmentId: EnvironmentId): DepsEntry {
  let entry = entries.get(environmentId);
  if (!entry) {
    const created: DepsEntry = {
      subscribe: (listener) => {
        const wasEmpty = created.listeners.size === 0;
        created.listeners.add(listener);
        if (wasEmpty) startEntry(environmentId, created);
        else fetchDeps(environmentId, false, true);
        return () => {
          created.listeners.delete(listener);
          teardownIfUnused(created);
        };
      },
      subscribePassive: (listener) => {
        created.passiveListeners.add(listener);
        return () => {
          created.passiveListeners.delete(listener);
        };
      },
      getSnapshot: () => created.snapshot,
      snapshot: EMPTY_DEPS,
      listeners: new Set(),
      passiveListeners: new Set(),
      inFlight: null,
      lastFetchedMs: 0,
      fetchSeq: 0,
      scanTimer: null,
      scanTicks: 0,
      unsubConnect: null,
    };
    entries.set(environmentId, created);
    entry = created;
  }
  return entry;
}

function emit(entry: DepsEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
  for (const listener of entry.passiveListeners) {
    listener();
  }
}

function stopScanPoll(entry: DepsEntry): void {
  if (entry.scanTimer !== null) {
    clearInterval(entry.scanTimer);
    entry.scanTimer = null;
  }
  entry.scanTicks = 0;
}

function pruneResolvedRepoKeys(
  tracked: Readonly<Record<string, string | null>>,
  payload: ShipQueueDepsPayload | null,
): Readonly<Record<string, string | null>> {
  const keys = Object.keys(tracked);
  if (keys.length === 0) return tracked;
  const repos = payload?.repos ?? [];
  let changed = false;
  const next: Record<string, string | null> = {};
  for (const repo of keys) {
    const prevKey = tracked[repo] ?? null;
    const cur = repos.find((r) => r.repo === repo && r.holding === true);
    if (!cur || depScanKey(cur) !== prevKey) {
      changed = true;
      continue;
    }
    next[repo] = prevKey;
  }
  return changed ? next : tracked;
}

function fetchDeps(environmentId: EnvironmentId, force: boolean, skipIfInFlight = false): void {
  const entry = getOrCreateEntry(environmentId);
  if (!hasConnectedEnvironment(environmentId)) return;
  const now = Date.now();
  if (entry.inFlight && (!force || skipIfInFlight)) return;
  if (!force && entry.lastFetchedMs > 0 && now - entry.lastFetchedMs < STALE_REVALIDATE_MS) {
    return;
  }

  entry.inFlight?.abort();
  const controller = new AbortController();
  entry.inFlight = controller;
  const seq = ++entry.fetchSeq;

  void ensureCapabilities(environmentId).then((caps) => {
    if (controller.signal.aborted || entry.fetchSeq !== seq) return;
    if (caps.unsupported || caps.capabilities?.tools.shipQueue === false) {
      entry.inFlight = null;
      entry.lastFetchedMs = Date.now();
      return;
    }
    const query = force ? { _r: String(seq) } : undefined;
    void fetchDevtoolsJson<ShipQueueDepsPayload>(environmentId, "/ship-queue/deps", {
      ...(query ? { query } : {}),
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted || entry.fetchSeq !== seq) return;
      entry.inFlight = null;
      entry.lastFetchedMs = Date.now();
      if (res.ok && res.data) {
        const nextScanning = pruneResolvedRepoKeys(entry.snapshot.scanningRepos, res.data);
        const nextDeciding = pruneResolvedRepoKeys(entry.snapshot.decidingRepos, res.data);
        if (Object.keys(nextScanning).length === 0 && Object.keys(nextDeciding).length === 0) {
          stopScanPoll(entry);
        }
        entry.snapshot = {
          payload: res.data,
          error: null,
          scanningRepos: nextScanning,
          decidingRepos: nextDeciding,
        };
        emit(entry);
      } else if (!res.ok && res.status !== 404 && res.error) {
        entry.snapshot = {
          ...entry.snapshot,
          error: res.error,
        };
        emit(entry);
      }
    });
  });
}

function ensureScanPoll(environmentId: EnvironmentId, entry: DepsEntry): void {
  if (entry.listeners.size === 0 || entry.scanTimer !== null) return;
  if (
    Object.keys(entry.snapshot.scanningRepos).length === 0 &&
    Object.keys(entry.snapshot.decidingRepos).length === 0
  ) {
    return;
  }
  entry.scanTicks = 0;
  entry.scanTimer = setInterval(() => {
    entry.scanTicks += 1;
    // Skip tick if a forced fetch is still in flight so >5s responses are not aborted (L3).
    fetchDeps(environmentId, true, true);
    if (entry.scanTicks >= MAX_SCAN_POLL_TICKS) {
      stopScanPoll(entry);
      entry.snapshot = {
        ...entry.snapshot,
        scanningRepos: {},
        decidingRepos: {},
      };
      emit(entry);
    }
  }, SCAN_POLL_MS);
}

function startEntry(environmentId: EnvironmentId, entry: DepsEntry): void {
  if (!entry.unsubConnect) {
    entry.unsubConnect = subscribeEnvironmentConnected(environmentId, () => {
      fetchDeps(environmentId, true, false);
    });
  }
  ensureScanPoll(environmentId, entry);
  fetchDeps(environmentId, false, true);
}

function teardownIfUnused(entry: DepsEntry): void {
  if (entry.listeners.size > 0) return;
  entry.inFlight?.abort();
  entry.inFlight = null;
  stopScanPoll(entry);
  entry.unsubConnect?.();
  entry.unsubConnect = null;
  if (entry.snapshot !== EMPTY_DEPS) {
    entry.snapshot = EMPTY_DEPS;
    entry.lastFetchedMs = 0;
    emit(entry);
  }
}

export function refreshSharedShipQueueDeps(environmentId: EnvironmentId): void {
  const entry = entries.get(environmentId);
  if (!entry || entry.listeners.size === 0) return;
  fetchDeps(environmentId, true, false);
}

export function markRepoDepsScanning(
  environmentId: EnvironmentId,
  repo: string,
  prevReportKey: string,
): void {
  const entry = getOrCreateEntry(environmentId);
  entry.snapshot = {
    ...entry.snapshot,
    scanningRepos: { ...entry.snapshot.scanningRepos, [repo]: prevReportKey },
  };
  emit(entry);
  ensureScanPoll(environmentId, entry);
  if (entry.listeners.size > 0) {
    fetchDeps(environmentId, true, false);
  }
}

export function markRepoDepsDeciding(
  environmentId: EnvironmentId,
  repo: string,
  prevReportKey: string,
): void {
  const entry = getOrCreateEntry(environmentId);
  entry.snapshot = {
    ...entry.snapshot,
    decidingRepos: { ...entry.snapshot.decidingRepos, [repo]: prevReportKey },
  };
  emit(entry);
  ensureScanPoll(environmentId, entry);
  if (entry.listeners.size > 0) {
    fetchDeps(environmentId, true, false);
  }
}

export function useSharedShipQueueDeps(
  environmentId: EnvironmentId | null,
  enabled = true,
): SharedShipQueueDepsSnapshot {
  const entry = enabled && environmentId ? getOrCreateEntry(environmentId) : null;
  return useSyncExternalStore(
    entry ? entry.subscribe : EMPTY_SUBSCRIBE,
    entry ? entry.getSnapshot : EMPTY_GET,
    EMPTY_GET,
  );
}

/**
 * Passive observer for cached dependency-hold snapshots. Never initiates `/ship-queue/deps` fetches
 * on its own (active polling is gated on live ship-queue jobs in `DevtoolsApprovalWatcher`).
 */
export function usePassiveShipQueueDeps(
  environmentId: EnvironmentId | null,
  enabled = true,
): SharedShipQueueDepsSnapshot {
  const entry = enabled && environmentId ? getOrCreateEntry(environmentId) : null;
  return useSyncExternalStore(
    entry ? entry.subscribePassive : EMPTY_SUBSCRIBE,
    entry ? entry.getSnapshot : EMPTY_GET,
    EMPTY_GET,
  );
}

const FALSE_GET = () => false;

/**
 * Boolean selector for sidebar rows: passively watches cached holds without triggering fetches
 * or per-row re-renders when no actionable dependency hold exists.
 */
export function useHasPassiveShipQueueDepHold(
  environmentId: EnvironmentId | null,
  enabled: boolean,
  isActionable: (repo: NonNullable<ShipQueueDepsPayload["repos"]>[number]) => boolean,
): boolean {
  const entry = enabled && environmentId ? getOrCreateEntry(environmentId) : null;
  return useSyncExternalStore(
    entry ? entry.subscribePassive : EMPTY_SUBSCRIBE,
    entry ? () => (entry.snapshot.payload?.repos ?? []).some(isActionable) : FALSE_GET,
    FALSE_GET,
  );
}

export function _resetDepsStoreForTests(): void {
  for (const entry of entries.values()) {
    entry.inFlight?.abort();
    stopScanPoll(entry);
    entry.unsubConnect?.();
  }
  entries.clear();
}
