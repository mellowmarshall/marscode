/**
 * Ref-counted single-EventSource multiplexer per EnvironmentId for `/api/devtools/events?topics=...`.
 * Coalesces simultaneous topic mounts (`guards`, `jobs`, `devdeck:passive`, `devdeck:active`)
 * onto ONE EventSource connection and handles unified reconnect, capability/scope fallback, and auth refresh.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import {
  buildDevtoolsStreamUrl,
  fetchDevtoolsJson,
  hasConnectedEnvironment,
  refreshDevtoolsStreamAccess,
  resolveDevtoolsStreamAccessAsync,
  subscribeEnvironmentConnected,
  type DevtoolsCapabilities,
} from "./devtoolsClient";

export type MuxTopicRegistration = "guards" | "jobs" | "devdeck:passive" | "devdeck:active";
type BaseMuxTopic = "guards" | "jobs" | "devdeck";

export interface MuxTopicCallbacks {
  readonly onOpen?: () => void;
  readonly onEvent: (eventName: string, rawData: string) => void;
  readonly onError?: () => void;
  readonly onFallbackNeeded?: () => void;
}

interface MuxSubscription {
  readonly topic: MuxTopicRegistration;
  readonly callbacks: MuxTopicCallbacks;
}

interface MuxChannel {
  readonly envId: EnvironmentId;
  readonly subs: Set<MuxSubscription>;
  es: EventSource | null;
  connecting: boolean;
  connectedSignature: string | null;
  forceReconnectPending: boolean;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  coalesceIsDowngrade: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  generation: number;
  unsubConn: (() => void) | null;
}

const MOUNT_COALESCE_MS = 40;
const DOWNGRADE_GRACE_MS = 3_000;

const TOPIC_EVENTS: Readonly<Record<BaseMuxTopic, ReadonlyArray<string>>> = {
  guards: ["event"],
  jobs: ["snapshot", "upsert", "remove", "meta", "unavailable"],
  devdeck: [
    "snapshot",
    "host",
    "servers",
    "sessions",
    "nodes",
    "hosts",
    "alerts",
    "ship",
    "usage",
    "worktrees",
    "unavailable",
  ],
};

const muxChannels = new Map<EnvironmentId, MuxChannel>();

function toBaseTopic(reg: MuxTopicRegistration): BaseMuxTopic {
  return reg === "devdeck:active" || reg === "devdeck:passive" ? "devdeck" : reg;
}

function hasBaseTopic(ch: MuxChannel, base: BaseMuxTopic): boolean {
  for (const sub of ch.subs) {
    if (toBaseTopic(sub.topic) === base) return true;
  }
  return false;
}

function computeDesiredQuery(ch: MuxChannel): {
  readonly signature: string;
  readonly topics: ReadonlyArray<BaseMuxTopic>;
  readonly query: Readonly<Record<string, string>>;
} | null {
  let wantGuards = false;
  let wantJobs = false;
  let wantDevdeckActive = false;
  let wantDevdeckPassive = false;

  for (const sub of ch.subs) {
    if (sub.topic === "guards") wantGuards = true;
    else if (sub.topic === "jobs") wantJobs = true;
    else if (sub.topic === "devdeck:active") wantDevdeckActive = true;
    else if (sub.topic === "devdeck:passive") wantDevdeckPassive = true;
  }

  const topics: BaseMuxTopic[] = [];
  if (wantDevdeckActive || wantDevdeckPassive) topics.push("devdeck");
  if (wantGuards) topics.push("guards");
  if (wantJobs) topics.push("jobs");
  if (topics.length === 0) return null;

  const query: Record<string, string> = { topics: topics.join(",") };
  if (wantDevdeckActive) {
    query.panels = "host,servers,sessions,nodes,hosts,alerts,ship,usage,worktrees";
  } else if (wantDevdeckPassive) {
    query.panels = "sessions,ship";
    query.passive = "1";
  }
  const signature = `${query.topics}|${query.panels ?? ""}|${query.passive ?? ""}`;
  return { signature, topics, query };
}

function closeMuxConn(ch: MuxChannel): void {
  ch.generation += 1;
  ch.connecting = false;
  ch.connectedSignature = null;
  if (ch.retryTimer !== null) {
    clearTimeout(ch.retryTimer);
    ch.retryTimer = null;
  }
  if (ch.es) {
    ch.es.close();
    ch.es = null;
  }
}

function notifyAllSubs(ch: MuxChannel, fn: (cb: MuxTopicCallbacks) => void): void {
  for (const sub of Array.from(ch.subs)) {
    fn(sub.callbacks);
  }
}

function notifyBaseTopicSubs(
  ch: MuxChannel,
  topic: BaseMuxTopic,
  fn: (cb: MuxTopicCallbacks) => void,
): void {
  for (const sub of Array.from(ch.subs)) {
    if (toBaseTopic(sub.topic) === topic) {
      fn(sub.callbacks);
    }
  }
}

function scheduleBackoffRetry(ch: MuxChannel, expectedGen: number): void {
  if (ch.generation !== expectedGen || ch.subs.size === 0) return;
  ch.retryTimer = setTimeout(() => {
    ch.retryTimer = null;
    if (ch.generation !== expectedGen || ch.subs.size === 0) return;
    ch.backoffMs = Math.min(30_000, Math.round(ch.backoffMs * 1.8));
    connectMux(ch);
  }, ch.backoffMs);
}

function connectMux(ch: MuxChannel): void {
  const desired = computeDesiredQuery(ch);
  if (!desired) {
    ch.forceReconnectPending = false;
    closeMuxConn(ch);
    return;
  }
  if (!hasConnectedEnvironment(ch.envId)) {
    closeMuxConn(ch);
    notifyAllSubs(ch, (cb) => cb.onError?.());
    return;
  }
  if (
    !ch.forceReconnectPending &&
    (ch.es || ch.connecting) &&
    ch.connectedSignature === desired.signature
  ) {
    return;
  }

  ch.forceReconnectPending = false;
  closeMuxConn(ch);
  ch.connecting = true;
  ch.connectedSignature = desired.signature;
  const gen = ch.generation;

  void resolveDevtoolsStreamAccessAsync(ch.envId)
    .then((access) => {
      if (ch.generation !== gen) return;
      const stillDesired = computeDesiredQuery(ch);
      if (!stillDesired || stillDesired.signature !== desired.signature) {
        ch.connecting = false;
        ch.connectedSignature = null;
        if (stillDesired) connectMux(ch);
        return;
      }
      if (!access) {
        ch.connecting = false;
        ch.connectedSignature = null;
        refreshDevtoolsStreamAccess(ch.envId);
        scheduleBackoffRetry(ch, gen);
        return;
      }

      const url = buildDevtoolsStreamUrl(access, "/events", desired.query);
      const es = new EventSource(url, { withCredentials: access.credentials });
      ch.es = es;
      ch.connecting = false;

      es.onopen = () => {
        if (ch.generation !== gen) return;
        ch.backoffMs = 1_500;
        notifyAllSubs(ch, (cb) => cb.onOpen?.());
      };

      for (const topic of desired.topics) {
        for (const eventName of TOPIC_EVENTS[topic]) {
          const muxEventName = `${topic}:${eventName}`;
          es.addEventListener(muxEventName, ((ev: MessageEvent<string>) => {
            if (ch.generation !== gen) return;
            notifyBaseTopicSubs(ch, topic, (cb) => cb.onEvent(eventName, ev.data));
          }) as EventListener);
        }
      }

      es.onerror = () => {
        if (ch.generation !== gen) return;
        closeMuxConn(ch);
        const errGen = ch.generation;
        notifyAllSubs(ch, (cb) => cb.onError?.());
        if (ch.generation !== errGen || ch.subs.size === 0) return;

        // Probe /capabilities to handle server downgrades (404) or single-topic scope loss (403)
        // cleanly without infinite reconnect loops or starving sibling topics.
        void fetchDevtoolsJson<DevtoolsCapabilities>(ch.envId, "/capabilities")
          .then((probe) => {
            if (ch.generation !== errGen || ch.subs.size === 0) return;
            if (
              probe.status === 404 ||
              (probe.ok && probe.data && probe.data.multiplexedEvents !== true)
            ) {
              notifyAllSubs(ch, (cb) => cb.onFallbackNeeded?.());
              return;
            }
            if (probe.ok && probe.data) {
              let prunedTopic = false;
              if (
                hasBaseTopic(ch, "guards") &&
                (probe.data.canApproveGuards === false || probe.data.guardBrokerListening === false)
              ) {
                prunedTopic = true;
                notifyBaseTopicSubs(ch, "guards", (cb) => cb.onFallbackNeeded?.());
              }
              if (
                hasBaseTopic(ch, "devdeck") &&
                (probe.data.canReadDiagnostics === false || !probe.data.tools.devdeck)
              ) {
                prunedTopic = true;
                notifyBaseTopicSubs(ch, "devdeck", (cb) => cb.onFallbackNeeded?.());
              }
              if (prunedTopic && ch.subs.size > 0 && ch.generation === errGen) {
                ch.backoffMs = 1_500;
                connectMux(ch);
                return;
              }
            }
            if (ch.generation !== errGen || ch.subs.size === 0) return;
            if (!access.credentials) {
              refreshDevtoolsStreamAccess(ch.envId);
            }
            scheduleBackoffRetry(ch, errGen);
          })
          .catch(() => {
            if (ch.generation !== errGen || ch.subs.size === 0) return;
            scheduleBackoffRetry(ch, errGen);
          });
      };
    })
    .catch(() => {
      if (ch.generation !== gen) return;
      ch.connecting = false;
      ch.connectedSignature = null;
      notifyAllSubs(ch, (cb) => cb.onError?.());
      scheduleBackoffRetry(ch, gen);
    });
}

function scheduleMuxSync(ch: MuxChannel, delayMs: number, isDowngrade = false): void {
  if (ch.coalesceTimer !== null) {
    if (isDowngrade && !ch.coalesceIsDowngrade) {
      return;
    }
    clearTimeout(ch.coalesceTimer);
    ch.coalesceTimer = null;
  }
  ch.coalesceIsDowngrade = isDowngrade;
  ch.coalesceTimer = setTimeout(() => {
    ch.coalesceTimer = null;
    ch.coalesceIsDowngrade = false;
    connectMux(ch);
  }, delayMs);
}

function getOrCreateMuxChannel(envId: EnvironmentId): MuxChannel {
  let ch = muxChannels.get(envId);
  if (!ch) {
    ch = {
      envId,
      subs: new Set(),
      es: null,
      connecting: false,
      connectedSignature: null,
      forceReconnectPending: false,
      coalesceTimer: null,
      coalesceIsDowngrade: false,
      retryTimer: null,
      backoffMs: 1_500,
      generation: 0,
      unsubConn: null,
    };
    muxChannels.set(envId, ch);
  }
  return ch;
}

export function subscribeMuxTopic(
  environmentId: EnvironmentId,
  topic: MuxTopicRegistration,
  callbacks: MuxTopicCallbacks,
): () => void {
  const ch = getOrCreateMuxChannel(environmentId);
  if (!ch.unsubConn) {
    ch.unsubConn = subscribeEnvironmentConnected(environmentId, (connected) => {
      if (connected) {
        if (ch.subs.size > 0 && !ch.es && !ch.connecting) {
          ch.backoffMs = 1_500;
          scheduleMuxSync(ch, MOUNT_COALESCE_MS);
        }
      } else {
        closeMuxConn(ch);
        notifyAllSubs(ch, (cb) => cb.onError?.());
      }
    });
  }

  const baseTopic = toBaseTopic(topic);
  const hadBaseTopicBefore = hasBaseTopic(ch, baseTopic);
  const sub: MuxSubscription = { topic, callbacks };
  ch.subs.add(sub);

  // Any 0 -> 1 topic transition must reconnect so the server sends a fresh initial snapshot
  // (preventing missed events or wiped state if a topic remounted during a grace window).
  if (!hadBaseTopicBefore) {
    ch.forceReconnectPending = true;
    scheduleMuxSync(ch, MOUNT_COALESCE_MS, false);
  } else {
    const desired = computeDesiredQuery(ch);
    const sameActiveStream =
      desired !== null &&
      desired.signature === ch.connectedSignature &&
      ch.es?.readyState === EventSource.OPEN;
    if (sameActiveStream) {
      queueMicrotask(() => {
        if (ch.subs.has(sub) && ch.es?.readyState === EventSource.OPEN) {
          callbacks.onOpen?.();
        }
      });
    } else if (topic === "devdeck:active" || !ch.coalesceIsDowngrade) {
      scheduleMuxSync(ch, MOUNT_COALESCE_MS, false);
    }
  }

  return () => {
    ch.subs.delete(sub);
    if (ch.subs.size === 0) {
      if (ch.coalesceTimer !== null) {
        clearTimeout(ch.coalesceTimer);
        ch.coalesceTimer = null;
        ch.coalesceIsDowngrade = false;
      }
      ch.forceReconnectPending = false;
      closeMuxConn(ch);
      if (ch.unsubConn) {
        ch.unsubConn();
        ch.unsubConn = null;
      }
      muxChannels.delete(environmentId);
      return;
    }
    const stillHasBase = hasBaseTopic(ch, baseTopic);
    const isActiveToPassiveDowngrade = topic === "devdeck:active" && stillHasBase;
    scheduleMuxSync(
      ch,
      isActiveToPassiveDowngrade ? DOWNGRADE_GRACE_MS : MOUNT_COALESCE_MS,
      isActiveToPassiveDowngrade,
    );
  };
}

export function forceReconnectMux(environmentId: EnvironmentId): void {
  const ch = muxChannels.get(environmentId);
  if (!ch || ch.subs.size === 0) return;
  ch.forceReconnectPending = true;
  closeMuxConn(ch);
  ch.backoffMs = 1_500;
  connectMux(ch);
}
