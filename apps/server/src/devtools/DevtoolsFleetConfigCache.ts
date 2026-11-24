// @effect-diagnostics globalDate:off - In-memory cache and background startup warm-up for fleet DevTools host-config snapshots.
import { defaultHostConfigPath, readDevtoolsHostConfig } from "./DevtoolsConfig.ts";
import {
  readFleetConfigSnapshot,
  type FleetConfigOptions,
  type FleetConfigSnapshot,
} from "./DevtoolsFleetConfig.ts";

const DEFAULT_CACHE_TTL_MS = 60_000;

let cachedSnapshot: FleetConfigSnapshot | null = null;
let cachedAtMs = 0;
let inFlight: Promise<FleetConfigSnapshot> | null = null;
let generation = 0;

function mergeFreshLocalConfig(
  snapshot: FleetConfigSnapshot,
  localConfigPathOverride?: string,
): FleetConfigSnapshot {
  const existingLocalPath = snapshot.hosts.find((entry) => entry.host.local)?.configPath;
  const localConfigPath = localConfigPathOverride ?? existingLocalPath ?? defaultHostConfigPath();
  const localConfig = readDevtoolsHostConfig(localConfigPath);
  const localJson = JSON.stringify(localConfig);
  return {
    ...snapshot,
    localConfig,
    hosts: snapshot.hosts.map((entry) => {
      if (entry.host.local) {
        return {
          ...entry,
          reachable: true,
          inSyncWithLocal: true,
          configPath: localConfigPath,
          config: localConfig,
        };
      }
      return {
        ...entry,
        inSyncWithLocal: entry.config !== null && JSON.stringify(entry.config) === localJson,
      };
    }),
  };
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function startBackgroundRefresh(
  options: Omit<FleetConfigOptions, "signal"> = {},
): Promise<FleetConfigSnapshot> {
  if (inFlight) return inFlight;
  const startedGen = generation;
  const run = readFleetConfigSnapshot(options)
    .then((snapshot) => {
      if (generation === startedGen) {
        cachedSnapshot = snapshot;
        cachedAtMs = Date.now();
      }
      return snapshot;
    })
    .finally(() => {
      if (inFlight === run) inFlight = null;
    });
  inFlight = run;
  return run;
}

/**
 * Triggers a single non-blocking fleet SSH config warm-up on server startup so Settings opens
 * immediately without waiting on remote SSH handshakes.
 */
export function warmFleetConfigCache(options?: Omit<FleetConfigOptions, "signal">): void {
  if (cachedSnapshot || inFlight) return;
  void startBackgroundRefresh(options).catch(() => undefined);
}

/**
 * Returns the cached fleet snapshot immediately (with fresh local disk config merged in) unless
 * `refresh: true` is requested or the cache has never been populated.
 */
export async function getCachedFleetConfigSnapshot(
  input: {
    readonly refresh?: boolean | undefined;
    readonly maxAgeMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly options?: Omit<FleetConfigOptions, "signal"> | undefined;
  } = {},
): Promise<FleetConfigSnapshot> {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_CACHE_TTL_MS;
  if (!input.refresh && cachedSnapshot && Date.now() - cachedAtMs < maxAgeMs) {
    return mergeFreshLocalConfig(cachedSnapshot, input.options?.localConfigPath);
  }
  const promise = startBackgroundRefresh(input.options);
  return awaitWithSignal(promise, input.signal);
}

/**
 * Invalidates the cached remote fleet state after a save so stale in-flight SSH probes cannot
 * clobber newer config writes, and kicks off a background refresh to re-populate sync badges.
 */
export function invalidateFleetConfigCache(options?: { readonly rewarm?: boolean }): void {
  generation += 1;
  cachedSnapshot = null;
  cachedAtMs = 0;
  inFlight = null;
  if (options?.rewarm) {
    void startBackgroundRefresh().catch(() => undefined);
  }
}

export function _resetFleetConfigCacheForTests(): void {
  generation += 1;
  cachedSnapshot = null;
  cachedAtMs = 0;
  inFlight = null;
}
