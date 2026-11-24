/**
 * Capability-gated, ref-counted shared SSE and cached snapshot streams per environment.
 * Supports passive (`passive=1`, sessions+nodes) vs active (Monitor modal) DevDeck modes.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import {
  decodeDevdeckHostsPanel,
  decodeDevdeckHostTelemetry,
  decodeDevdeckShipPanel,
} from "./devdeckSchema";
import {
  buildDevtoolsStreamUrl,
  fetchDevtoolsJson,
  hasConnectedEnvironment,
  refreshDevtoolsStreamAccess,
  resolveDevtoolsStreamAccessAsync,
  subscribeEnvironmentConnected,
  type DevdeckAlertItem,
  type DevdeckAlertsPanel,
  type DevdeckHostsPanel,
  type DevdeckHostTelemetry,
  type DevdeckNodeState,
  type DevdeckServerItem,
  type DevdeckSessionItem,
  type DevdeckShipPanel,
  type DevdeckUsagePanel,
  type DevdeckWorktreesPanel,
  type DevleaseOverview,
  type DevtoolsCapabilities,
  type ShipQueueStatusPayload,
} from "./devtoolsClient";
import { forceReconnectMux, subscribeMuxTopic } from "./devtoolsEventMux";
import {
  deriveFetchResourceStatus,
  deriveStreamResourceStatus,
  type DevtoolsResourceStatus,
} from "./devtoolsState";

export interface SharedCapabilitiesSnapshot {
  readonly capabilities: DevtoolsCapabilities | null;
  readonly unsupported: boolean;
  readonly checked: boolean;
}

export interface SharedShipQueueSnapshot {
  readonly payload: ShipQueueStatusPayload | null;
  readonly live: boolean;
  readonly error: string | null;
  readonly unsupported: boolean;
  readonly status: DevtoolsResourceStatus;
}

export interface SharedDevdeckPanels {
  readonly host: DevdeckHostTelemetry | null;
  readonly servers: ReadonlyArray<DevdeckServerItem>;
  readonly sessions: ReadonlyArray<DevdeckSessionItem>;
  readonly nodes: Readonly<Record<string, DevdeckNodeState>>;
  readonly hosts: DevdeckHostsPanel | null;
  readonly alerts: DevdeckAlertsPanel | null;
  readonly ship: DevdeckShipPanel | null;
  readonly usage: DevdeckUsagePanel | null;
  readonly worktrees: DevdeckWorktreesPanel | null;
}

export interface SharedDevdeckSnapshot {
  readonly panels: SharedDevdeckPanels | null;
  readonly live: boolean;
  readonly error: string | null;
  readonly unsupported: boolean;
  readonly status: DevtoolsResourceStatus;
}

export interface SharedDevleaseSnapshot {
  readonly overview: DevleaseOverview | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly status: DevtoolsResourceStatus;
}

const EMPTY_CAPABILITIES: SharedCapabilitiesSnapshot = {
  capabilities: null,
  unsupported: false,
  checked: false,
};

const EMPTY_SHIP_QUEUE: SharedShipQueueSnapshot = {
  payload: null,
  live: false,
  error: null,
  unsupported: false,
  status: "connecting",
};

const EMPTY_DEVDECK: SharedDevdeckSnapshot = {
  panels: null,
  live: false,
  error: null,
  unsupported: false,
  status: "connecting",
};

const EMPTY_DEVLEASE: SharedDevleaseSnapshot = {
  overview: null,
  loading: false,
  error: null,
  status: "connecting",
};

const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_CAPS_GET = () => EMPTY_CAPABILITIES;
const EMPTY_SHIP_GET = () => EMPTY_SHIP_QUEUE;
const EMPTY_DEVDECK_GET = () => EMPTY_DEVDECK;
const EMPTY_DEVLEASE_GET = () => EMPTY_DEVLEASE;

const CAPABILITIES_TTL_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 30_000;
const DEVLEASE_CACHE_MS = 60_000;
const DEVDECK_TEARDOWN_GRACE_MS = 15_000;
const DEVDECK_NOTIFY_COALESCE_MS = 32;

function parseServers(raw: unknown): ReadonlyArray<DevdeckServerItem> {
  if (Array.isArray(raw)) return raw as ReadonlyArray<DevdeckServerItem>;
  if (raw && typeof raw === "object" && Array.isArray((raw as { servers?: unknown }).servers)) {
    return (raw as { servers: ReadonlyArray<DevdeckServerItem> }).servers;
  }
  return [];
}

function parseSessions(raw: unknown): ReadonlyArray<DevdeckSessionItem> {
  return Array.isArray(raw) ? (raw as ReadonlyArray<DevdeckSessionItem>) : [];
}

function parseNodes(raw: unknown): Readonly<Record<string, DevdeckNodeState>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Readonly<Record<string, DevdeckNodeState>>;
}

function parseHosts(raw: unknown): DevdeckHostsPanel | null | undefined {
  if (raw === null) return null;
  const decoded = decodeDevdeckHostsPanel(raw);
  if (decoded === null) {
    console.warn("[devtools] DevDeck hosts panel decode failed; keeping previous snapshot");
    return undefined;
  }
  return decoded;
}

function parseHostTelemetry(raw: unknown): DevdeckHostTelemetry | null | undefined {
  if (raw === null) return null;
  const decoded = decodeDevdeckHostTelemetry(raw);
  if (decoded === null) {
    console.warn("[devtools] DevDeck host panel decode failed; keeping previous snapshot");
    return undefined;
  }
  return decoded;
}

function parseAlerts(raw: unknown): DevdeckAlertsPanel | null | undefined {
  if (raw === null) return null;
  if (Array.isArray(raw)) return { items: raw as ReadonlyArray<DevdeckAlertItem> };
  if (typeof raw !== "object") return undefined;
  return raw as DevdeckAlertsPanel;
}

function parseShip(raw: unknown): DevdeckShipPanel | null | undefined {
  if (raw === null) return null;
  const decoded = decodeDevdeckShipPanel(raw);
  if (decoded === null) {
    console.warn("[devtools] DevDeck ship panel decode failed; keeping previous snapshot");
    return undefined;
  }
  return decoded;
}

function parseUsage(raw: unknown): DevdeckUsagePanel | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as DevdeckUsagePanel;
}

function parseWorktrees(raw: unknown): DevdeckWorktreesPanel | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as DevdeckWorktreesPanel;
}

function mergeDevdeckPanels(
  prev: SharedDevdeckPanels | null,
  patch: { readonly [K in keyof SharedDevdeckPanels]?: SharedDevdeckPanels[K] | undefined },
): SharedDevdeckPanels {
  return {
    host: patch.host !== undefined ? patch.host : (prev?.host ?? null),
    servers: patch.servers !== undefined ? patch.servers : (prev?.servers ?? []),
    sessions: patch.sessions !== undefined ? patch.sessions : (prev?.sessions ?? []),
    nodes: patch.nodes !== undefined ? patch.nodes : (prev?.nodes ?? {}),
    hosts: patch.hosts !== undefined ? patch.hosts : (prev?.hosts ?? null),
    alerts: patch.alerts !== undefined ? patch.alerts : (prev?.alerts ?? null),
    ship: patch.ship !== undefined ? patch.ship : (prev?.ship ?? null),
    usage: patch.usage !== undefined ? patch.usage : (prev?.usage ?? null),
    worktrees: patch.worktrees !== undefined ? patch.worktrees : (prev?.worktrees ?? null),
  };
}

interface CapabilitiesChannel {
  readonly envId: EnvironmentId;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedCapabilitiesSnapshot;
  snapshot: SharedCapabilitiesSnapshot;
  listeners: Set<() => void>;
  fetchedAtMs: number;
  inFlight: Promise<SharedCapabilitiesSnapshot> | null;
  pendingForce: boolean;
}

const capsChannels = new Map<EnvironmentId, CapabilitiesChannel>();

function getOrCreateCapsChannel(envId: EnvironmentId): CapabilitiesChannel {
  let ch = capsChannels.get(envId);
  if (!ch) {
    const channel: CapabilitiesChannel = {
      envId,
      snapshot: EMPTY_CAPABILITIES,
      listeners: new Set(),
      fetchedAtMs: 0,
      inFlight: null,
      pendingForce: false,
      getSnapshot: () => channel.snapshot,
      subscribe: (listener) => {
        channel.listeners.add(listener);
        ensureEnvConnectionWatcher(envId);
        return () => {
          channel.listeners.delete(listener);
          maybeReleaseEnvConnectionWatcher(envId);
        };
      },
    };
    ch = channel;
    capsChannels.set(envId, ch);
  }
  return ch;
}

function notifyCaps(ch: CapabilitiesChannel): void {
  for (const l of ch.listeners) l();
}

export function ensureCapabilities(
  envId: EnvironmentId,
  force = false,
): Promise<SharedCapabilitiesSnapshot> {
  const ch = getOrCreateCapsChannel(envId);
  if (!hasConnectedEnvironment(envId)) {
    return Promise.resolve(ch.snapshot);
  }
  if (!force && ch.snapshot.checked && Date.now() - ch.fetchedAtMs < CAPABILITIES_TTL_MS) {
    return Promise.resolve(ch.snapshot);
  }
  if (ch.inFlight) {
    if (force) {
      ch.pendingForce = true;
      return ch.inFlight.then((snap) => ch.inFlight ?? snap);
    }
    return ch.inFlight;
  }
  ch.pendingForce = false;
  let succeeded = false;
  ch.inFlight = fetchDevtoolsJson<DevtoolsCapabilities>(envId, "/capabilities")
    .then((res) => {
      if (res.status === 404) {
        ch.fetchedAtMs = Date.now();
        ch.snapshot = { capabilities: null, unsupported: true, checked: true };
      } else if (res.ok && res.data) {
        succeeded = true;
        ch.fetchedAtMs = Date.now();
        ch.snapshot = { capabilities: res.data, unsupported: false, checked: true };
      } else {
        // Use a short 5s retry window on transient probe errors instead of caching failure for 60s.
        ch.fetchedAtMs = Date.now() - CAPABILITIES_TTL_MS + 5_000;
        ch.snapshot = { ...ch.snapshot, checked: true };
      }
      notifyCaps(ch);
      return ch.snapshot;
    })
    .finally(() => {
      ch.inFlight = null;
      if (ch.pendingForce && !succeeded) {
        ch.pendingForce = false;
        void ensureCapabilities(envId, true);
      } else {
        ch.pendingForce = false;
      }
    });
  return ch.inFlight;
}

export function readCachedCapabilities(
  environmentId: EnvironmentId,
): SharedCapabilitiesSnapshot | null {
  return capsChannels.get(environmentId)?.snapshot ?? null;
}

export function useSharedCapabilities(
  environmentId: EnvironmentId | null,
): SharedCapabilitiesSnapshot {
  const ch = environmentId ? getOrCreateCapsChannel(environmentId) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads cached host capabilities when mounted
  useEffect(() => {
    if (!environmentId) return;
    void ensureCapabilities(environmentId, false);
  }, [environmentId]);

  return useSyncExternalStore(
    ch ? ch.subscribe : NOOP_SUBSCRIBE,
    ch ? ch.getSnapshot : EMPTY_CAPS_GET,
    EMPTY_CAPS_GET,
  );
}

interface ShipQueueChannel {
  readonly envId: EnvironmentId;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedShipQueueSnapshot;
  snapshot: SharedShipQueueSnapshot;
  listeners: Set<() => void>;
  es: EventSource | null;
  connecting: boolean;
  hasConnectedOnce: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  generation: number;
}

const shipQueueChannels = new Map<EnvironmentId, ShipQueueChannel>();

function notifyShipQueue(ch: ShipQueueChannel): void {
  const status = deriveStreamResourceStatus({
    unsupported: ch.snapshot.unsupported,
    live: ch.snapshot.live,
    hasData: ch.snapshot.payload !== null,
    error: ch.snapshot.error,
  });
  if (ch.snapshot.status !== status) {
    ch.snapshot = { ...ch.snapshot, status };
  }
  for (const l of ch.listeners) l();
}

function closeShipQueueConn(ch: ShipQueueChannel): void {
  ch.generation += 1;
  ch.connecting = false;
  if (ch.retryTimer !== null) {
    clearTimeout(ch.retryTimer);
    ch.retryTimer = null;
  }
  if (ch.es) {
    ch.es.close();
    ch.es = null;
  }
}

function connectShipQueueChannel(ch: ShipQueueChannel): void {
  if (ch.listeners.size === 0) {
    return;
  }
  ensureEnvConnectionWatcher(ch.envId);
  if (!hasConnectedEnvironment(ch.envId)) {
    const offlineMsg = ch.hasConnectedOnce
      ? m(msg("Environment is offline or disconnected"))
      : null;
    if (ch.snapshot.live || ch.snapshot.error !== offlineMsg) {
      ch.snapshot = { ...ch.snapshot, live: false, error: offlineMsg };
      notifyShipQueue(ch);
    }
    return;
  }
  closeShipQueueConn(ch);
  ch.connecting = true;
  if (ch.snapshot.error !== null) {
    ch.snapshot = { ...ch.snapshot, error: null };
    notifyShipQueue(ch);
  }
  const gen = ch.generation;

  void ensureCapabilities(ch.envId).then((caps) => {
    if (ch.generation !== gen) return;
    if (ch.listeners.size === 0) {
      ch.connecting = false;
      return;
    }
    if (caps.unsupported) {
      ch.connecting = false;
      ch.snapshot = { ...ch.snapshot, live: false, unsupported: true };
      notifyShipQueue(ch);
      ensureUpgradeRecoveryListeners();
      return;
    }
    if (caps.capabilities && !caps.capabilities.tools.shipQueue) {
      ch.connecting = false;
      ch.snapshot = {
        ...ch.snapshot,
        live: false,
        error: m(msg("ship-queue is not installed on this host")),
      };
      notifyShipQueue(ch);
      return;
    }

    void resolveDevtoolsStreamAccessAsync(ch.envId).then((access) => {
      if (ch.generation !== gen) return;
      if (ch.listeners.size === 0) {
        ch.connecting = false;
        return;
      }
      if (!access) {
        ch.connecting = false;
        refreshDevtoolsStreamAccess(ch.envId);
        ch.retryTimer = setTimeout(() => {
          ch.retryTimer = null;
          ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
          connectShipQueueChannel(ch);
        }, ch.backoffMs);
        return;
      }

      const url = buildDevtoolsStreamUrl(access, "/ship-queue/events");
      const es = new EventSource(url, { withCredentials: access.credentials });
      ch.es = es;
      ch.connecting = false;

      es.onopen = () => {
        if (ch.generation !== gen) return;
        ch.hasConnectedOnce = true;
        ch.backoffMs = 1_500;
        if (!ch.snapshot.live || ch.snapshot.error !== null) {
          ch.snapshot = { ...ch.snapshot, live: true, error: null };
          notifyShipQueue(ch);
        }
      };

      es.addEventListener("snapshot", ((ev: MessageEvent<string>) => {
        if (ch.generation !== gen) return;
        try {
          const parsed = JSON.parse(ev.data) as ShipQueueStatusPayload;
          if (parsed && typeof parsed === "object") {
            ch.hasConnectedOnce = true;
            ch.snapshot = {
              payload: parsed,
              live: true,
              error: null,
              unsupported: false,
              status: "ready",
            };
            notifyShipQueue(ch);
          }
        } catch {
          // ignore malformed frame
        }
      }) as EventListener);

      es.addEventListener("unavailable", ((ev: MessageEvent<string>) => {
        if (ch.generation !== gen) return;
        closeShipQueueConn(ch);
        let errMsg = m(msg("ship-queue unavailable"));
        try {
          const parsed = JSON.parse(ev.data) as { error?: string };
          if (parsed.error) errMsg = parsed.error;
        } catch {
          // default error message
        }
        ch.snapshot = { ...ch.snapshot, live: false, error: errMsg };
        notifyShipQueue(ch);
        ch.retryTimer = setTimeout(() => {
          ch.retryTimer = null;
          connectShipQueueChannel(ch);
        }, UNAVAILABLE_RETRY_MS);
      }) as EventListener);

      es.onerror = () => {
        if (ch.generation !== gen) return;
        closeShipQueueConn(ch);
        const errGen = ch.generation;
        if (ch.snapshot.live) {
          ch.snapshot = { ...ch.snapshot, live: false };
          notifyShipQueue(ch);
        }
        void ensureCapabilities(ch.envId, true).then((probe) => {
          if (ch.generation !== errGen || ch.listeners.size === 0) return;
          if (probe.unsupported) {
            ch.snapshot = { ...ch.snapshot, live: false, unsupported: true };
            notifyShipQueue(ch);
            ensureUpgradeRecoveryListeners();
            return;
          }
          if (!access.credentials) {
            refreshDevtoolsStreamAccess(ch.envId);
          }
          ch.retryTimer = setTimeout(() => {
            ch.retryTimer = null;
            ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
            connectShipQueueChannel(ch);
          }, ch.backoffMs);
        });
      };
    });
  });
}

function getOrCreateShipQueueChannel(envId: EnvironmentId): ShipQueueChannel {
  let ch = shipQueueChannels.get(envId);
  if (!ch) {
    const channel: ShipQueueChannel = {
      envId,
      snapshot: EMPTY_SHIP_QUEUE,
      listeners: new Set(),
      es: null,
      connecting: false,
      hasConnectedOnce: false,
      retryTimer: null,
      teardownTimer: null,
      backoffMs: 1_500,
      generation: 0,
      getSnapshot: () => channel.snapshot,
      subscribe: (listener) => {
        if (channel.teardownTimer !== null) {
          clearTimeout(channel.teardownTimer);
          channel.teardownTimer = null;
        }
        channel.listeners.add(listener);
        ensureEnvConnectionWatcher(envId);
        if (
          !channel.es &&
          !channel.connecting &&
          channel.retryTimer === null &&
          !channel.snapshot.unsupported
        ) {
          connectShipQueueChannel(channel);
        }
        return () => {
          channel.listeners.delete(listener);
          if (channel.listeners.size === 0) {
            channel.teardownTimer = setTimeout(() => {
              channel.teardownTimer = null;
              if (channel.listeners.size === 0) {
                closeShipQueueConn(channel);
                channel.backoffMs = 1_500;
                maybeReleaseEnvConnectionWatcher(envId);
              }
            }, 2_000);
          }
        };
      },
    };
    ch = channel;
    shipQueueChannels.set(envId, ch);
  }
  return ch;
}

export function useSharedShipQueue(environmentId: EnvironmentId | null): SharedShipQueueSnapshot {
  const ch = environmentId ? getOrCreateShipQueueChannel(environmentId) : null;
  return useSyncExternalStore(
    ch ? ch.subscribe : NOOP_SUBSCRIBE,
    ch ? ch.getSnapshot : EMPTY_SHIP_GET,
    EMPTY_SHIP_GET,
  );
}

export function useSharedShipQueueSelector<T>(
  environmentId: EnvironmentId | null,
  selector: (snapshot: SharedShipQueueSnapshot) => T,
): T {
  const ch = environmentId ? getOrCreateShipQueueChannel(environmentId) : null;
  return useSyncExternalStore(
    ch ? ch.subscribe : NOOP_SUBSCRIBE,
    () => selector(ch ? ch.getSnapshot() : EMPTY_SHIP_QUEUE),
    () => selector(EMPTY_SHIP_QUEUE),
  );
}

export type DevdeckStreamMode = "passive" | "active";

interface DevdeckChannel {
  readonly envId: EnvironmentId;
  readonly subscribePassive: (listener: () => void) => () => void;
  readonly subscribeActive: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedDevdeckSnapshot;
  snapshot: SharedDevdeckSnapshot;
  listeners: Set<() => void>;
  activeCount: number;
  connectedMode: DevdeckStreamMode | null;
  es: EventSource | null;
  muxUnsub: (() => void) | null;
  connecting: boolean;
  hasConnectedOnce: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  notifyTimer: ReturnType<typeof setTimeout> | null;
  lastRawByPanel: Map<string, string>;
  backoffMs: number;
  generation: number;
}

const devdeckChannels = new Map<EnvironmentId, DevdeckChannel>();

function syncDevdeckStatus(ch: DevdeckChannel): void {
  const status = deriveStreamResourceStatus({
    unsupported: ch.snapshot.unsupported,
    live: ch.snapshot.live,
    hasData: ch.snapshot.panels !== null,
    error: ch.snapshot.error,
  });
  if (ch.snapshot.status !== status) {
    ch.snapshot = { ...ch.snapshot, status };
  }
}

function notifyDevdeck(ch: DevdeckChannel): void {
  if (ch.notifyTimer !== null) {
    clearTimeout(ch.notifyTimer);
    ch.notifyTimer = null;
  }
  syncDevdeckStatus(ch);
  for (const l of ch.listeners) l();
}

function scheduleNotifyDevdeck(ch: DevdeckChannel): void {
  if (ch.notifyTimer !== null) return;
  ch.notifyTimer = setTimeout(() => {
    ch.notifyTimer = null;
    syncDevdeckStatus(ch);
    for (const l of ch.listeners) l();
  }, DEVDECK_NOTIFY_COALESCE_MS);
}

function desiredDevdeckMode(ch: DevdeckChannel): DevdeckStreamMode {
  return ch.activeCount > 0 ? "active" : "passive";
}

function closeDevdeckConn(ch: DevdeckChannel): void {
  ch.generation += 1;
  ch.connecting = false;
  ch.connectedMode = null;
  ch.lastRawByPanel.clear();
  if (ch.retryTimer !== null) {
    clearTimeout(ch.retryTimer);
    ch.retryTimer = null;
  }
  if (ch.notifyTimer !== null) {
    clearTimeout(ch.notifyTimer);
    ch.notifyTimer = null;
  }
  if (ch.es) {
    ch.es.close();
    ch.es = null;
  }
  if (ch.muxUnsub) {
    ch.muxUnsub();
    ch.muxUnsub = null;
  }
}

function isDevdeckActiveStream(ch: DevdeckChannel): boolean {
  return Boolean(ch.es || ch.muxUnsub);
}

const DEVDECK_PANEL_PARSERS: Readonly<
  Record<
    keyof SharedDevdeckPanels,
    (raw: unknown) => SharedDevdeckPanels[keyof SharedDevdeckPanels] | undefined
  >
> = {
  host: parseHostTelemetry,
  servers: parseServers,
  sessions: parseSessions,
  nodes: parseNodes,
  hosts: parseHosts,
  alerts: parseAlerts,
  ship: parseShip,
  usage: parseUsage,
  worktrees: parseWorktrees,
};

function applyDevdeckSnapshotJson(ch: DevdeckChannel, rawData: string): void {
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;
    if (ch.retryTimer !== null) {
      clearTimeout(ch.retryTimer);
      ch.retryTimer = null;
    }
    ch.hasConnectedOnce = true;
    ch.lastRawByPanel.clear();
    ch.snapshot = {
      panels: mergeDevdeckPanels(ch.snapshot.panels, {
        ...("host" in parsed ? { host: parseHostTelemetry(parsed.host) } : {}),
        ...("servers" in parsed ? { servers: parseServers(parsed.servers) } : {}),
        ...("sessions" in parsed ? { sessions: parseSessions(parsed.sessions) } : {}),
        ...("nodes" in parsed ? { nodes: parseNodes(parsed.nodes) } : {}),
        ...("hosts" in parsed ? { hosts: parseHosts(parsed.hosts) } : {}),
        ...("alerts" in parsed ? { alerts: parseAlerts(parsed.alerts) } : {}),
        ...("ship" in parsed ? { ship: parseShip(parsed.ship) } : {}),
        ...("usage" in parsed ? { usage: parseUsage(parsed.usage) } : {}),
        ...("worktrees" in parsed ? { worktrees: parseWorktrees(parsed.worktrees) } : {}),
      }),
      live: true,
      error: null,
      unsupported: false,
      status: "ready",
    };
    notifyDevdeck(ch);
  } catch {
    // ignore malformed snapshot
  }
}

function applyDevdeckPanelJson(
  ch: DevdeckChannel,
  key: keyof SharedDevdeckPanels,
  rawData: string,
): void {
  if (ch.lastRawByPanel.get(key) === rawData) return;
  try {
    const value = DEVDECK_PANEL_PARSERS[key](JSON.parse(rawData) as unknown);
    ch.lastRawByPanel.set(key, rawData);
    if (value === undefined) return;
    ch.snapshot = {
      ...ch.snapshot,
      panels: mergeDevdeckPanels(ch.snapshot.panels, {
        [key]: value,
      } as { readonly [K in keyof SharedDevdeckPanels]?: SharedDevdeckPanels[K] | undefined }),
    };
    scheduleNotifyDevdeck(ch);
  } catch {
    // ignore malformed panel frame
  }
}

function connectDevdeckChannel(ch: DevdeckChannel): void {
  if (ch.listeners.size === 0) {
    return;
  }
  ensureEnvConnectionWatcher(ch.envId);
  if (!hasConnectedEnvironment(ch.envId)) {
    const offlineMsg = ch.hasConnectedOnce
      ? m(msg("Environment is offline or disconnected"))
      : null;
    if (ch.snapshot.live || ch.snapshot.error !== offlineMsg) {
      ch.snapshot = { ...ch.snapshot, live: false, error: offlineMsg };
      notifyDevdeck(ch);
    }
    return;
  }
  const mode = desiredDevdeckMode(ch);
  closeDevdeckConn(ch);
  ch.connecting = true;
  ch.connectedMode = mode;
  const gen = ch.generation;

  void ensureCapabilities(ch.envId).then((caps) => {
    if (ch.generation !== gen) return;
    if (ch.listeners.size === 0) {
      ch.connecting = false;
      ch.connectedMode = null;
      return;
    }
    if (caps.unsupported) {
      ch.connecting = false;
      ch.connectedMode = null;
      ch.snapshot = {
        ...ch.snapshot,
        live: false,
        unsupported: true,
        error: m(msg("Devtools API is not supported on this host")),
      };
      notifyDevdeck(ch);
      ensureUpgradeRecoveryListeners();
      return;
    }
    if (caps.capabilities?.canReadDiagnostics === false) {
      ch.connecting = false;
      ch.connectedMode = null;
      ch.snapshot = {
        ...ch.snapshot,
        live: false,
        error: m(msg("Diagnostics permission is required to view DevDeck")),
      };
      notifyDevdeck(ch);
      return;
    }
    if (
      caps.capabilities &&
      (!caps.capabilities.tools.devdeck || caps.capabilities.devdeckReachable === false)
    ) {
      ch.connecting = false;
      ch.connectedMode = null;
      ch.snapshot = {
        ...ch.snapshot,
        live: false,
        error: caps.capabilities.tools.devdeck
          ? m(msg("DevDeck daemon is not running on this host"))
          : m(msg("DevDeck is not installed on this host")),
      };
      notifyDevdeck(ch);
      if (ch.retryTimer !== null) clearTimeout(ch.retryTimer);
      ch.retryTimer = setTimeout(() => {
        ch.retryTimer = null;
        if (ch.generation !== gen || ch.listeners.size === 0) return;
        void ensureCapabilities(ch.envId, true).then(() => {
          if (ch.generation === gen && ch.listeners.size > 0) {
            connectDevdeckChannel(ch);
          }
        });
      }, UNAVAILABLE_RETRY_MS);
      return;
    }
    // Never open a passive stream against an older DevDeck daemon that lacks `passive=1`,
    // otherwise viewing a thread card would wake Fast collector cadence while Monitor is closed.
    if (mode === "passive" && caps.capabilities?.devdeckPassiveSupported !== true) {
      ch.connecting = false;
      ch.connectedMode = null;
      return;
    }

    if (caps.capabilities?.multiplexedEvents === true) {
      ch.connecting = false;
      ch.muxUnsub = subscribeMuxTopic(
        ch.envId,
        mode === "active" ? "devdeck:active" : "devdeck:passive",
        {
          onOpen: () => {
            if (ch.generation !== gen) return;
            ch.hasConnectedOnce = true;
            ch.backoffMs = 1_500;
            // Only clear non-unavailable state on mux open; unavailable clears once a real snapshot/panel arrives.
            if (!ch.snapshot.live && ch.snapshot.error === null) {
              ch.snapshot = { ...ch.snapshot, live: true };
              notifyDevdeck(ch);
            }
          },
          onEvent: (eventName, rawData) => {
            if (ch.generation !== gen) return;
            if (eventName === "snapshot") {
              applyDevdeckSnapshotJson(ch, rawData);
              return;
            }
            if (eventName === "unavailable") {
              ch.snapshot = {
                ...ch.snapshot,
                live: false,
                error: m(msg("DevDeck daemon is not running on this host")),
              };
              notifyDevdeck(ch);
              // Probe lightweight HTTP snapshot instead of tearing down sibling guards/jobs on the mux.
              const scheduleProbe = () => {
                if (ch.retryTimer !== null) clearTimeout(ch.retryTimer);
                ch.retryTimer = setTimeout(() => {
                  ch.retryTimer = null;
                  if (ch.generation !== gen || ch.listeners.size === 0) return;
                  void fetchDevtoolsJson<Record<string, unknown>>(ch.envId, "/devdeck/snapshot", {
                    query: { panels: "host" },
                  }).then((res) => {
                    if (ch.generation !== gen || ch.listeners.size === 0) return;
                    if (res.ok && res.data) {
                      forceReconnectMux(ch.envId);
                    } else {
                      scheduleProbe();
                    }
                  });
                }, UNAVAILABLE_RETRY_MS);
              };
              scheduleProbe();
              return;
            }
            if (Object.hasOwn(DEVDECK_PANEL_PARSERS, eventName)) {
              if (ch.retryTimer !== null) {
                clearTimeout(ch.retryTimer);
                ch.retryTimer = null;
              }
              if (!ch.snapshot.live || ch.snapshot.error !== null) {
                ch.snapshot = { ...ch.snapshot, live: true, error: null };
              }
              applyDevdeckPanelJson(ch, eventName as keyof SharedDevdeckPanels, rawData);
            }
          },
          onError: () => {
            if (ch.generation !== gen) return;
            if (ch.snapshot.live) {
              ch.snapshot = { ...ch.snapshot, live: false };
              notifyDevdeck(ch);
            }
          },
          onFallbackNeeded: () => {
            if (ch.generation !== gen) return;
            closeDevdeckConn(ch);
            void ensureCapabilities(ch.envId, true).then((probe) => {
              if (ch.listeners.size === 0) return;
              if (probe.unsupported) {
                ch.snapshot = { ...ch.snapshot, live: false, unsupported: true };
                notifyDevdeck(ch);
                ensureUpgradeRecoveryListeners();
                return;
              }
              connectDevdeckChannel(ch);
            });
          },
        },
      );
      return;
    }

    void resolveDevtoolsStreamAccessAsync(ch.envId).then((access) => {
      if (ch.generation !== gen) return;
      if (ch.listeners.size === 0) {
        ch.connecting = false;
        ch.connectedMode = null;
        return;
      }
      if (!access) {
        ch.connecting = false;
        ch.connectedMode = null;
        refreshDevtoolsStreamAccess(ch.envId);
        ch.retryTimer = setTimeout(() => {
          ch.retryTimer = null;
          ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
          connectDevdeckChannel(ch);
        }, ch.backoffMs);
        return;
      }

      const query: Record<string, string> =
        mode === "active"
          ? { panels: "host,servers,sessions,nodes,hosts,alerts,ship,usage,worktrees" }
          : { panels: "sessions,ship", passive: "1" };

      const url = buildDevtoolsStreamUrl(access, "/devdeck/events", query);
      const es = new EventSource(url, { withCredentials: access.credentials });
      ch.es = es;
      ch.connecting = false;

      es.onopen = () => {
        if (ch.generation !== gen) return;
        ch.hasConnectedOnce = true;
        ch.backoffMs = 1_500;
        if (!ch.snapshot.live || ch.snapshot.error !== null) {
          ch.snapshot = { ...ch.snapshot, live: true, error: null };
          notifyDevdeck(ch);
        }
      };

      es.addEventListener("snapshot", ((ev: MessageEvent<string>) => {
        if (ch.generation !== gen) return;
        try {
          const parsed = JSON.parse(ev.data) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            ch.hasConnectedOnce = true;
            ch.lastRawByPanel.clear();
            ch.snapshot = {
              panels: mergeDevdeckPanels(ch.snapshot.panels, {
                ...("host" in parsed ? { host: parseHostTelemetry(parsed.host) } : {}),
                ...("servers" in parsed ? { servers: parseServers(parsed.servers) } : {}),
                ...("sessions" in parsed ? { sessions: parseSessions(parsed.sessions) } : {}),
                ...("nodes" in parsed ? { nodes: parseNodes(parsed.nodes) } : {}),
                ...("hosts" in parsed ? { hosts: parseHosts(parsed.hosts) } : {}),
                ...("alerts" in parsed ? { alerts: parseAlerts(parsed.alerts) } : {}),
                ...("ship" in parsed ? { ship: parseShip(parsed.ship) } : {}),
                ...("usage" in parsed ? { usage: parseUsage(parsed.usage) } : {}),
                ...("worktrees" in parsed ? { worktrees: parseWorktrees(parsed.worktrees) } : {}),
              }),
              live: true,
              error: null,
              unsupported: false,
              status: "ready",
            };
            notifyDevdeck(ch);
          }
        } catch {
          // ignore
        }
      }) as EventListener);

      const bindPanel = <K extends keyof SharedDevdeckPanels>(
        eventName: string,
        key: K,
        parser: (raw: unknown) => SharedDevdeckPanels[K] | undefined,
      ) => {
        es.addEventListener(eventName, ((ev: MessageEvent<string>) => {
          if (ch.generation !== gen) return;
          if (ch.lastRawByPanel.get(eventName) === ev.data) return;
          try {
            const value = parser(JSON.parse(ev.data) as unknown);
            ch.lastRawByPanel.set(eventName, ev.data);
            if (value === undefined) return;
            ch.snapshot = {
              ...ch.snapshot,
              panels: mergeDevdeckPanels(ch.snapshot.panels, {
                [key]: value,
              } as Partial<SharedDevdeckPanels>),
            };
            scheduleNotifyDevdeck(ch);
          } catch {
            // ignore
          }
        }) as EventListener);
      };

      bindPanel("host", "host", parseHostTelemetry);
      bindPanel("servers", "servers", parseServers);
      bindPanel("sessions", "sessions", parseSessions);
      bindPanel("nodes", "nodes", parseNodes);
      bindPanel("hosts", "hosts", parseHosts);
      bindPanel("alerts", "alerts", parseAlerts);
      bindPanel("ship", "ship", parseShip);
      bindPanel("usage", "usage", parseUsage);
      bindPanel("worktrees", "worktrees", parseWorktrees);

      es.addEventListener("unavailable", () => {
        if (ch.generation !== gen) return;
        closeDevdeckConn(ch);
        ch.snapshot = {
          ...ch.snapshot,
          live: false,
          error: m(msg("DevDeck daemon is not running on this host")),
        };
        notifyDevdeck(ch);
        ch.retryTimer = setTimeout(() => {
          ch.retryTimer = null;
          connectDevdeckChannel(ch);
        }, UNAVAILABLE_RETRY_MS);
      });

      es.onerror = () => {
        if (ch.generation !== gen) return;
        closeDevdeckConn(ch);
        const errGen = ch.generation;
        if (ch.snapshot.live) {
          ch.snapshot = { ...ch.snapshot, live: false };
          notifyDevdeck(ch);
        }
        void ensureCapabilities(ch.envId, true).then((probe) => {
          if (ch.generation !== errGen || ch.listeners.size === 0) return;
          if (probe.unsupported) {
            ch.snapshot = { ...ch.snapshot, live: false, unsupported: true };
            notifyDevdeck(ch);
            ensureUpgradeRecoveryListeners();
            return;
          }
          if (!access.credentials) {
            refreshDevtoolsStreamAccess(ch.envId);
          }
          ch.retryTimer = setTimeout(() => {
            ch.retryTimer = null;
            ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
            connectDevdeckChannel(ch);
          }, ch.backoffMs);
        });
      };
    });
  });
}

function makeDevdeckSubscriber(channel: DevdeckChannel, mode: DevdeckStreamMode) {
  return (listener: () => void) => {
    if (channel.teardownTimer !== null) {
      clearTimeout(channel.teardownTimer);
      channel.teardownTimer = null;
    }
    channel.listeners.add(listener);
    ensureEnvConnectionWatcher(channel.envId);
    if (mode === "active") channel.activeCount += 1;
    const nextDesired = desiredDevdeckMode(channel);

    if (
      channel.connectedMode !== nextDesired &&
      (isDevdeckActiveStream(channel) || channel.connecting)
    ) {
      connectDevdeckChannel(channel);
    } else if (
      !isDevdeckActiveStream(channel) &&
      !channel.connecting &&
      channel.retryTimer === null &&
      !channel.snapshot.unsupported
    ) {
      connectDevdeckChannel(channel);
    }

    return () => {
      channel.listeners.delete(listener);
      if (mode === "active") channel.activeCount = Math.max(0, channel.activeCount - 1);
      if (channel.teardownTimer !== null) {
        clearTimeout(channel.teardownTimer);
        channel.teardownTimer = null;
      }
      if (channel.listeners.size === 0) {
        channel.teardownTimer = setTimeout(() => {
          channel.teardownTimer = null;
          if (channel.listeners.size === 0) {
            closeDevdeckConn(channel);
            channel.backoffMs = 1_500;
            maybeReleaseEnvConnectionWatcher(channel.envId);
          }
        }, DEVDECK_TEARDOWN_GRACE_MS);
      } else if (channel.connectedMode === "active" && channel.activeCount === 0) {
        channel.teardownTimer = setTimeout(() => {
          channel.teardownTimer = null;
          if (
            channel.listeners.size > 0 &&
            channel.connectedMode === "active" &&
            channel.activeCount === 0
          ) {
            connectDevdeckChannel(channel);
          }
        }, DEVDECK_TEARDOWN_GRACE_MS);
      }
    };
  };
}

function getOrCreateDevdeckChannel(envId: EnvironmentId): DevdeckChannel {
  let ch = devdeckChannels.get(envId);
  if (!ch) {
    const channel: DevdeckChannel = {
      envId,
      snapshot: EMPTY_DEVDECK,
      listeners: new Set(),
      activeCount: 0,
      connectedMode: null,
      es: null,
      muxUnsub: null,
      connecting: false,
      hasConnectedOnce: false,
      retryTimer: null,
      teardownTimer: null,
      notifyTimer: null,
      lastRawByPanel: new Map(),
      backoffMs: 1_500,
      generation: 0,
      getSnapshot: () => channel.snapshot,
      subscribePassive: NOOP_SUBSCRIBE,
      subscribeActive: NOOP_SUBSCRIBE,
    };
    (channel as { subscribePassive: DevdeckChannel["subscribePassive"] }).subscribePassive =
      makeDevdeckSubscriber(channel, "passive");
    (channel as { subscribeActive: DevdeckChannel["subscribeActive"] }).subscribeActive =
      makeDevdeckSubscriber(channel, "active");
    ch = channel;
    devdeckChannels.set(envId, ch);
  }
  return ch;
}

export async function refreshSharedDevdeck(envId: EnvironmentId): Promise<void> {
  const ch = getOrCreateDevdeckChannel(envId);
  if (!hasConnectedEnvironment(envId)) {
    ch.snapshot = {
      ...ch.snapshot,
      live: false,
      error: m(msg("Environment is offline or disconnected")),
    };
    notifyDevdeck(ch);
    return;
  }
  await ensureCapabilities(envId, true);
  const wasUnhealthy = !ch.snapshot.live || ch.snapshot.error !== null;
  const res = await fetchDevtoolsJson<Record<string, unknown>>(envId, "/devdeck/snapshot", {
    query: { panels: "host,servers,sessions,nodes,hosts,alerts,ship,usage,worktrees" },
  });
  if (res.ok && res.data) {
    ch.lastRawByPanel.clear();
    ch.snapshot = {
      ...ch.snapshot,
      panels: mergeDevdeckPanels(ch.snapshot.panels, {
        ...("host" in res.data ? { host: parseHostTelemetry(res.data.host) } : {}),
        ...("servers" in res.data ? { servers: parseServers(res.data.servers) } : {}),
        ...("sessions" in res.data ? { sessions: parseSessions(res.data.sessions) } : {}),
        ...("nodes" in res.data ? { nodes: parseNodes(res.data.nodes) } : {}),
        ...("hosts" in res.data ? { hosts: parseHosts(res.data.hosts) } : {}),
        ...("alerts" in res.data ? { alerts: parseAlerts(res.data.alerts) } : {}),
        ...("ship" in res.data ? { ship: parseShip(res.data.ship) } : {}),
        ...("usage" in res.data ? { usage: parseUsage(res.data.usage) } : {}),
        ...("worktrees" in res.data ? { worktrees: parseWorktrees(res.data.worktrees) } : {}),
      }),
      error: null,
      unsupported: false,
    };
    notifyDevdeck(ch);
    if (ch.listeners.size > 0) {
      if (!isDevdeckActiveStream(ch) && !ch.connecting) {
        connectDevdeckChannel(ch);
      } else if (wasUnhealthy && ch.muxUnsub) {
        forceReconnectMux(envId);
      }
    }
  } else {
    ch.snapshot = {
      ...ch.snapshot,
      error: res.error ?? m(msg("DevDeck daemon not reachable")),
    };
    notifyDevdeck(ch);
  }
}

export function useSharedDevdeck(
  environmentId: EnvironmentId | null,
  mode: DevdeckStreamMode = "passive",
): SharedDevdeckSnapshot {
  const ch = environmentId ? getOrCreateDevdeckChannel(environmentId) : null;
  const subscribe = ch
    ? mode === "active"
      ? ch.subscribeActive
      : ch.subscribePassive
    : NOOP_SUBSCRIBE;
  return useSyncExternalStore(
    subscribe,
    ch ? ch.getSnapshot : EMPTY_DEVDECK_GET,
    EMPTY_DEVDECK_GET,
  );
}

interface DevleaseChannel {
  readonly envId: EnvironmentId;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SharedDevleaseSnapshot;
  snapshot: SharedDevleaseSnapshot;
  listeners: Set<() => void>;
  fetchedAtMs: number;
  hasBoots: boolean;
  requestedBoots: boolean;
  inFlight: Promise<void> | null;
}

const devleaseChannels = new Map<EnvironmentId, DevleaseChannel>();

function getOrCreateDevleaseChannel(envId: EnvironmentId): DevleaseChannel {
  let ch = devleaseChannels.get(envId);
  if (!ch) {
    const channel: DevleaseChannel = {
      envId,
      snapshot: EMPTY_DEVLEASE,
      listeners: new Set(),
      fetchedAtMs: 0,
      hasBoots: false,
      requestedBoots: false,
      inFlight: null,
      getSnapshot: () => channel.snapshot,
      subscribe: (listener) => {
        channel.listeners.add(listener);
        ensureEnvConnectionWatcher(envId);
        return () => {
          channel.listeners.delete(listener);
          maybeReleaseEnvConnectionWatcher(envId);
        };
      },
    };
    ch = channel;
    devleaseChannels.set(envId, ch);
  }
  return ch;
}

function notifyDevlease(ch: DevleaseChannel): void {
  const err = ch.snapshot.error ?? ch.snapshot.overview?.error ?? null;
  const status = deriveFetchResourceStatus({
    loading: ch.snapshot.loading,
    hasData: Boolean(ch.snapshot.overview?.available),
    error: err,
    unconfigured: ch.snapshot.overview !== null && !ch.snapshot.overview.available && !err,
  });
  if (ch.snapshot.status !== status || ch.snapshot.error !== err) {
    ch.snapshot = { ...ch.snapshot, error: err, status };
  }
  for (const l of ch.listeners) l();
}

export async function refreshSharedDevlease(
  envId: EnvironmentId,
  options: { readonly force?: boolean; readonly includeBoots?: boolean } = {},
): Promise<void> {
  const force = options.force ?? true;
  const includeBoots = options.includeBoots ?? true;
  const ch = getOrCreateDevleaseChannel(envId);
  if (includeBoots) ch.requestedBoots = true;
  if (ch.listeners.size > 0) ensureEnvConnectionWatcher(envId);
  if (!hasConnectedEnvironment(envId)) {
    if (ch.snapshot.overview !== null) {
      const offlineErr = m(msg("Environment is offline or disconnected"));
      ch.snapshot = {
        ...ch.snapshot,
        loading: false,
        error: offlineErr,
        overview: {
          available: false,
          list: null,
          boots: null,
          error: offlineErr,
        },
      };
      notifyDevlease(ch);
    }
    return;
  }

  const caps = await ensureCapabilities(envId, force);
  if (caps.unsupported) {
    ch.snapshot = {
      ...ch.snapshot,
      loading: false,
      error: null,
      status: "unconfigured",
    };
    notifyDevlease(ch);
    return;
  }
  if (caps.capabilities?.canReadDiagnostics === false) {
    ch.fetchedAtMs = Date.now();
    const permErr = m(msg("Diagnostics permission is required to view DevLease"));
    ch.snapshot = {
      ...ch.snapshot,
      loading: false,
      error: permErr,
      overview: {
        available: false,
        list: null,
        boots: null,
        error: permErr,
      },
    };
    notifyDevlease(ch);
    return;
  }
  if (caps.capabilities && !caps.capabilities.tools.devlease) {
    ch.fetchedAtMs = Date.now();
    const missingErr = m(msg("devlease is not installed on this host"));
    ch.snapshot = {
      ...ch.snapshot,
      loading: false,
      error: missingErr,
      overview: {
        available: false,
        list: null,
        boots: null,
        error: missingErr,
      },
    };
    notifyDevlease(ch);
    return;
  }

  const fresh = Date.now() - ch.fetchedAtMs < DEVLEASE_CACHE_MS && ch.snapshot.overview !== null;
  if (!force && fresh && (!includeBoots || ch.hasBoots)) {
    return;
  }
  if (ch.inFlight) return ch.inFlight;

  ch.snapshot = { ...ch.snapshot, loading: true };
  notifyDevlease(ch);
  ch.inFlight = fetchDevtoolsJson<DevleaseOverview>(envId, "/devlease/overview", {
    query: includeBoots ? undefined : { includeBoots: "0" },
  })
    .then((res) => {
      ch.fetchedAtMs = Date.now();
      if (res.data) {
        const mergedBoots = includeBoots ? res.data.boots : (ch.snapshot.overview?.boots ?? null);
        if (includeBoots) ch.hasBoots = true;
        ch.snapshot = {
          ...ch.snapshot,
          loading: false,
          error: res.data.error ?? null,
          overview: { ...res.data, boots: mergedBoots },
        };
      } else {
        const errText = res.error ?? m(msg("Failed to load DevLease overview"));
        ch.snapshot = {
          ...ch.snapshot,
          loading: false,
          error: errText,
          overview: {
            available: false,
            list: null,
            boots: null,
            error: errText,
          },
        };
      }
      notifyDevlease(ch);
    })
    .finally(() => {
      ch.inFlight = null;
    });
  return ch.inFlight;
}

export function useSharedDevlease(
  environmentId: EnvironmentId | null,
  includeBoots = false,
): SharedDevleaseSnapshot {
  const ch = environmentId ? getOrCreateDevleaseChannel(environmentId) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads cached DevLease snapshot when mounted
  useEffect(() => {
    if (!environmentId) return;
    void refreshSharedDevlease(environmentId, { force: false, includeBoots });
  }, [environmentId, includeBoots]);

  return useSyncExternalStore(
    ch ? ch.subscribe : NOOP_SUBSCRIBE,
    ch ? ch.getSnapshot : EMPTY_DEVLEASE_GET,
    EMPTY_DEVLEASE_GET,
  );
}

const envConnectionWatchers = new Map<EnvironmentId, () => void>();

function hasAnyEnvListeners(envId: EnvironmentId): boolean {
  return (
    (capsChannels.get(envId)?.listeners.size ?? 0) > 0 ||
    (shipQueueChannels.get(envId)?.listeners.size ?? 0) > 0 ||
    (devdeckChannels.get(envId)?.listeners.size ?? 0) > 0 ||
    (devleaseChannels.get(envId)?.listeners.size ?? 0) > 0
  );
}

function handleEnvironmentConnectionChange(envId: EnvironmentId, connected: boolean): void {
  if (connected) {
    const capsCh = capsChannels.get(envId);
    if (
      capsCh &&
      capsCh.listeners.size > 0 &&
      (!capsCh.snapshot.checked || capsCh.snapshot.capabilities === null)
    ) {
      void ensureCapabilities(envId, true);
    }

    const shipCh = shipQueueChannels.get(envId);
    if (
      shipCh &&
      shipCh.listeners.size > 0 &&
      !shipCh.es &&
      !shipCh.connecting &&
      !shipCh.snapshot.unsupported
    ) {
      shipCh.backoffMs = 1_500;
      connectShipQueueChannel(shipCh);
    }

    const devdeckCh = devdeckChannels.get(envId);
    if (
      devdeckCh &&
      devdeckCh.listeners.size > 0 &&
      !isDevdeckActiveStream(devdeckCh) &&
      !devdeckCh.connecting &&
      !devdeckCh.snapshot.unsupported
    ) {
      devdeckCh.backoffMs = 1_500;
      connectDevdeckChannel(devdeckCh);
    }

    const devleaseCh = devleaseChannels.get(envId);
    if (
      devleaseCh &&
      devleaseCh.listeners.size > 0 &&
      (devleaseCh.snapshot.overview === null || !devleaseCh.snapshot.overview.available)
    ) {
      void refreshSharedDevlease(envId, {
        force: true,
        includeBoots: devleaseCh.requestedBoots || devleaseCh.hasBoots,
      });
    }
    return;
  }

  const shipCh = shipQueueChannels.get(envId);
  if (shipCh) {
    closeShipQueueConn(shipCh);
    const offlineMsg = shipCh.hasConnectedOnce
      ? m(msg("Environment is offline or disconnected"))
      : null;
    if (shipCh.snapshot.live || shipCh.snapshot.error !== offlineMsg) {
      shipCh.snapshot = { ...shipCh.snapshot, live: false, error: offlineMsg };
      notifyShipQueue(shipCh);
    }
  }

  const devdeckCh = devdeckChannels.get(envId);
  if (devdeckCh) {
    closeDevdeckConn(devdeckCh);
    const offlineMsg = devdeckCh.hasConnectedOnce
      ? m(msg("Environment is offline or disconnected"))
      : null;
    if (devdeckCh.snapshot.live || devdeckCh.snapshot.error !== offlineMsg) {
      devdeckCh.snapshot = { ...devdeckCh.snapshot, live: false, error: offlineMsg };
      notifyDevdeck(devdeckCh);
    }
  }
}

function ensureEnvConnectionWatcher(envId: EnvironmentId): void {
  if (envConnectionWatchers.has(envId)) return;
  const unsubscribe = subscribeEnvironmentConnected(envId, (connected) => {
    handleEnvironmentConnectionChange(envId, connected);
  });
  envConnectionWatchers.set(envId, unsubscribe);
}

function maybeReleaseEnvConnectionWatcher(envId: EnvironmentId): void {
  if (hasAnyEnvListeners(envId)) return;
  const unsubscribe = envConnectionWatchers.get(envId);
  if (unsubscribe) {
    unsubscribe();
    envConnectionWatchers.delete(envId);
  }
}

let upgradeRecoveryAttached = false;

function handleUpgradeRecovery(): void {
  let anyStillUnsupported = false;
  for (const ch of shipQueueChannels.values()) {
    if (ch.listeners.size > 0 && ch.snapshot.unsupported && !ch.es && !ch.connecting) {
      anyStillUnsupported = true;
      connectShipQueueChannel(ch);
    }
  }
  for (const ch of devdeckChannels.values()) {
    if (
      ch.listeners.size > 0 &&
      ch.snapshot.unsupported &&
      !isDevdeckActiveStream(ch) &&
      !ch.connecting
    ) {
      anyStillUnsupported = true;
      connectDevdeckChannel(ch);
    }
  }
  if (!anyStillUnsupported && upgradeRecoveryAttached && typeof window !== "undefined") {
    upgradeRecoveryAttached = false;
    window.removeEventListener("focus", handleUpgradeRecovery);
    window.removeEventListener("online", handleUpgradeRecovery);
  }
}

function ensureUpgradeRecoveryListeners(): void {
  if (upgradeRecoveryAttached || typeof window === "undefined") return;
  upgradeRecoveryAttached = true;
  window.addEventListener("focus", handleUpgradeRecovery);
  window.addEventListener("online", handleUpgradeRecovery);
}
