/**
 * Module-level + localStorage-backed cache for DevTools fleet host configuration (`/config/fleet`).
 * Warms once at startup in the background so Settings -> DevTools opens instantaneously with cached
 * config while running a quiet background drift check (corner spinner only, no blocking loader).
 */
import { useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import {
  fetchDevtoolsJson,
  type DevtoolsConfigPayload,
  type FleetConfigSnapshot,
} from "./devtoolsClient";

export interface FleetConfigStoreSnapshot {
  readonly fleetSnapshot: FleetConfigSnapshot | null;
  readonly localPayload: DevtoolsConfigPayload | null;
  readonly checking: boolean;
  readonly error: string | null;
  readonly lastCheckedMs: number;
}

const EMPTY_SNAPSHOT: FleetConfigStoreSnapshot = {
  fleetSnapshot: null,
  localPayload: null,
  checking: false,
  error: null,
  lastCheckedMs: 0,
};

const EMPTY_SUBSCRIBE = () => () => {};
const EMPTY_GET = () => EMPTY_SNAPSHOT;
const STORAGE_KEY_PREFIX = "t3.devtools.fleetConfig.v1:";
const DRIFT_CHECK_MIN_INTERVAL_MS = 15_000;

interface FleetConfigEntry {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FleetConfigStoreSnapshot;
  snapshot: FleetConfigStoreSnapshot;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  localInFlight: Promise<void> | null;
  warmed: boolean;
  requestSeq: number;
}

const entries = new Map<EnvironmentId, FleetConfigEntry>();

function readPersistedSnapshot(environmentId: EnvironmentId): FleetConfigSnapshot | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${environmentId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { localHost?: unknown }).localHost !== "string" ||
      !Array.isArray((parsed as { hosts?: unknown }).hosts) ||
      !(parsed as { localConfig?: unknown }).localConfig
    ) {
      return null;
    }
    return parsed as FleetConfigSnapshot;
  } catch {
    return null;
  }
}

function writePersistedSnapshot(environmentId: EnvironmentId, snapshot: FleetConfigSnapshot): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${environmentId}`, JSON.stringify(snapshot));
  } catch {
    // ignore storage quota/privacy failures
  }
}

function toLocalPayload(snapshot: FleetConfigSnapshot): DevtoolsConfigPayload {
  return {
    configPath: snapshot.configPath,
    config: snapshot.localConfig,
    resolved: snapshot.resolved,
  };
}

function emit(entry: FleetConfigEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

function getOrCreateEntry(environmentId: EnvironmentId): FleetConfigEntry {
  let entry = entries.get(environmentId);
  if (!entry) {
    const persisted = readPersistedSnapshot(environmentId);
    const initial: FleetConfigStoreSnapshot = persisted
      ? {
          fleetSnapshot: persisted,
          localPayload: toLocalPayload(persisted),
          checking: false,
          error: null,
          lastCheckedMs: 0,
        }
      : EMPTY_SNAPSHOT;
    const created: FleetConfigEntry = {
      subscribe: (listener) => {
        created.listeners.add(listener);
        return () => {
          created.listeners.delete(listener);
        };
      },
      getSnapshot: () => created.snapshot,
      snapshot: initial,
      listeners: new Set(),
      inFlight: null,
      localInFlight: null,
      warmed: false,
      requestSeq: 0,
    };
    entries.set(environmentId, created);
    entry = created;
  }
  return entry;
}

function ensureFastLocalConfig(environmentId: EnvironmentId, entry: FleetConfigEntry): void {
  if (entry.snapshot.localPayload || entry.localInFlight) return;
  const run = fetchDevtoolsJson<DevtoolsConfigPayload>(environmentId, "/config")
    .then((res) => {
      if (res.ok && res.data && !entry.snapshot.fleetSnapshot && !entry.snapshot.localPayload) {
        entry.snapshot = {
          ...entry.snapshot,
          localPayload: res.data,
          error: null,
        };
        emit(entry);
      }
    })
    .finally(() => {
      if (entry.localInFlight === run) entry.localInFlight = null;
    });
  entry.localInFlight = run;
}

function runFleetFetch(
  environmentId: EnvironmentId,
  entry: FleetConfigEntry,
  options: { readonly refresh: boolean; readonly showChecking: boolean },
): void {
  if (entry.inFlight && !options.refresh) return;
  const seq = ++entry.requestSeq;
  if (options.showChecking && (!entry.snapshot.checking || entry.snapshot.error !== null)) {
    entry.snapshot = { ...entry.snapshot, checking: true, error: null };
    emit(entry);
  }
  const query = options.refresh ? { refresh: "1" } : undefined;
  const run = fetchDevtoolsJson<FleetConfigSnapshot>(
    environmentId,
    "/config/fleet",
    query ? { query } : undefined,
  )
    .then(async (fleetRes) => {
      if (entry.requestSeq !== seq) return;
      if (fleetRes.ok && fleetRes.data) {
        const snap = fleetRes.data;
        writePersistedSnapshot(environmentId, snap);
        entry.snapshot = {
          fleetSnapshot: snap,
          localPayload: toLocalPayload(snap),
          checking: false,
          error: null,
          lastCheckedMs: Date.now(),
        };
        emit(entry);
        return;
      }
      // Fallback to single-host /config if /config/fleet is unsupported or failed and nothing is cached yet.
      if (!entry.snapshot.localPayload) {
        const localRes = await fetchDevtoolsJson<DevtoolsConfigPayload>(environmentId, "/config");
        if (entry.requestSeq !== seq) return;
        if (localRes.ok && localRes.data) {
          entry.snapshot = {
            ...entry.snapshot,
            localPayload: localRes.data,
            checking: false,
            error: null,
            lastCheckedMs: Date.now(),
          };
          emit(entry);
          return;
        }
        entry.snapshot = {
          ...entry.snapshot,
          checking: false,
          error:
            localRes.error ??
            fleetRes.error ??
            m(msg("Failed to load DevTools host configuration")),
        };
        emit(entry);
        return;
      }
      // Keep cached config visible when a background drift check encounters a transient error.
      entry.snapshot = {
        ...entry.snapshot,
        checking: false,
      };
      emit(entry);
    })
    .finally(() => {
      if (entry.inFlight === run) entry.inFlight = null;
    });
  entry.inFlight = run;
}

/**
 * Warms the fleet DevTools config once per connected environment at startup in the background.
 */
export function warmFleetConfigInBackground(environmentId: EnvironmentId): void {
  const entry = getOrCreateEntry(environmentId);
  if (entry.warmed) return;
  entry.warmed = true;
  runFleetFetch(environmentId, entry, { refresh: false, showChecking: false });
}

/**
 * Called when Settings -> DevTools opens or when the user clicks Refresh.
 * Immediately renders cached (or 1ms local `/config`) data while checking remote hosts for drift
 * in the background using the corner spinner.
 */
export function checkFleetConfigDrift(
  environmentId: EnvironmentId,
  options?: { readonly forceRefresh?: boolean },
): void {
  const entry = getOrCreateEntry(environmentId);
  const force = options?.forceRefresh === true;
  if (!entry.snapshot.fleetSnapshot && !entry.snapshot.localPayload) {
    ensureFastLocalConfig(environmentId, entry);
  }
  if (!force && entry.inFlight) {
    if (!entry.snapshot.checking) {
      entry.snapshot = { ...entry.snapshot, checking: true };
      emit(entry);
    }
    return;
  }
  const recentlyChecked =
    entry.snapshot.lastCheckedMs > 0 &&
    Date.now() - entry.snapshot.lastCheckedMs < DRIFT_CHECK_MIN_INTERVAL_MS;
  if (!force && recentlyChecked) return;
  const shouldRefreshRemote = force || entry.snapshot.lastCheckedMs > 0;
  entry.warmed = true;
  runFleetFetch(environmentId, entry, { refresh: shouldRefreshRemote, showChecking: true });
}

/**
 * Immediately updates cached config after a save and kicks off a quiet background drift recheck.
 */
export function recordSavedFleetConfig(
  environmentId: EnvironmentId,
  saved: DevtoolsConfigPayload,
): void {
  const entry = getOrCreateEntry(environmentId);
  const prevFleet = entry.snapshot.fleetSnapshot;
  const results = saved.results;
  const hasResults = Array.isArray(results) && results.length > 0;
  const resultByHost = hasResults ? new Map(results.map((r) => [r.host, r])) : null;
  const localResult = hasResults ? results.find((r) => r.local) : undefined;
  const localUpdated = hasResults
    ? Boolean(localResult?.ok && localResult.config)
    : saved.ok !== false;
  const nextLocalConfig =
    localResult?.ok && localResult.config
      ? localResult.config
      : !hasResults && saved.ok !== false
        ? saved.config
        : (prevFleet?.localConfig ?? entry.snapshot.localPayload?.config ?? null);
  const nextLocalPayload: DevtoolsConfigPayload | null = localUpdated
    ? {
        configPath: saved.configPath,
        config: nextLocalConfig ?? saved.config,
        resolved: saved.resolved,
      }
    : entry.snapshot.localPayload;

  let nextFleet: FleetConfigSnapshot | null = null;
  if (prevFleet && nextLocalConfig) {
    const localJson = JSON.stringify(nextLocalConfig);
    const updatedFleet: FleetConfigSnapshot = {
      ...prevFleet,
      configPath: localUpdated ? saved.configPath : prevFleet.configPath,
      localConfig: nextLocalConfig,
      resolved: localUpdated ? saved.resolved : prevFleet.resolved,
      hosts: prevFleet.hosts.map((h) => {
        if (h.host.local) {
          if (!localUpdated) return h;
          const { error: _clearedError, ...hostRest } = h;
          return {
            ...hostRest,
            reachable: true,
            exists: true,
            inSyncWithLocal: true,
            config: nextLocalConfig,
          };
        }
        const matched = resultByHost?.get(h.host.name);
        if (matched?.ok && matched.config) {
          const { error: _clearedError, ...hostRest } = h;
          return {
            ...hostRest,
            reachable: true,
            exists: true,
            config: matched.config,
            inSyncWithLocal: JSON.stringify(matched.config) === localJson,
          };
        }
        return {
          ...h,
          inSyncWithLocal: h.config !== null && JSON.stringify(h.config) === localJson,
        };
      }),
    };
    nextFleet = updatedFleet;
    writePersistedSnapshot(environmentId, updatedFleet);
  }

  entry.snapshot = {
    ...entry.snapshot,
    fleetSnapshot: nextFleet ?? prevFleet,
    localPayload: nextLocalPayload,
    error: null,
  };
  emit(entry);
  runFleetFetch(environmentId, entry, { refresh: true, showChecking: true });
}

export function useFleetConfigStore(
  environmentId: EnvironmentId | undefined,
): FleetConfigStoreSnapshot {
  const entry = environmentId ? getOrCreateEntry(environmentId) : null;
  return useSyncExternalStore(
    entry ? entry.subscribe : EMPTY_SUBSCRIBE,
    entry ? entry.getSnapshot : EMPTY_GET,
    EMPTY_GET,
  );
}

export function _resetFleetConfigStoreForTests(): void {
  entries.clear();
}
