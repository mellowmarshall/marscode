// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Native T3 Fleet Service replacing DevDeck daemon for host metrics, servers, sessions, CI hosts, SSE, and in-memory routing telemetry.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HostPowerSnapshot, HostResourcesSnapshot } from "@t3tools/contracts";
import type { FleetTelemetryProvider } from "@t3tools/ship-queue/ciRouter";

import type { CiToggleRequest } from "./CiToggleAudit.ts";
import { FleetActionTracker } from "./FleetActionTracker.ts";
import { buildFleetAlertsPanel, defaultGitHubAuditPath } from "./FleetAlerts.ts";
import { FleetCachedPanel } from "./FleetCachedPanel.ts";
import {
  buildLocalHostTelemetry,
  buildSelfNodeState,
  type SelfNodeOptions,
} from "./FleetSelfNode.ts";
import { createFleetEventStream, type FleetSseListener } from "./FleetSseStream.ts";
import type {
  FleetAction,
  FleetAlertsPanel,
  FleetHostTelemetry,
  FleetNodeState,
  FleetSnapshot,
  FleetWorktreesPanel,
} from "./FleetTypes.ts";
import { defaultT3StateDir, NativeCiHosts, readCiHostsManifest } from "./NativeCiHosts.ts";
import { NativeHostSampler } from "./NativeHostSampler.ts";
import { NativeServersScanner } from "./NativeServersScanner.ts";
import { NativeSessionsScanner, type ParsedPsProcess } from "./NativeSessionsScanner.ts";
import { type PeerLinkCandidate, RemoteNodeProber } from "./RemoteNodeProber.ts";

const ACTIVE_HOST_INTERVAL_MS = 1_000;
const ACTIVE_SCANS_INTERVAL_MS = 5_000;
const BACKGROUND_INTERVAL_MS = 30_000;
const ON_DEMAND_SCAN_TTL_MS = 15_000;
const KICK_LEASE_MS = 12_000;
const KICK_MIN_INTERVAL_MS = 4_500;
const WORKTREES_TTL_MS = 60_000;

export interface NativeFleetServiceDeps {
  readonly hostname?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly stateDir?: string | undefined;
  readonly queueRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly repoDirs?:
    | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
    | undefined;
  readonly enableBackgroundPolling?: boolean | undefined;
  readonly readHostResources?: (() => Promise<HostResourcesSnapshot | null>) | undefined;
  readonly readDesktopPower?: (() => Promise<HostPowerSnapshot | null>) | undefined;
  readonly listPeerLinks?: (() => Promise<ReadonlyArray<PeerLinkCandidate>>) | undefined;
  readonly githubAuditPath?: string | undefined;
  readonly readWorktrees?: (() => Promise<FleetWorktreesPanel | null>) | undefined;
  /** Receives each fresh process table from the sessions scan (live job loads). */
  readonly onProcessTable?: ((rows: ReadonlyArray<ParsedPsProcess>) => void) | undefined;
  /** Test seams: the active workload scan cadence and the panel-cache clock. */
  readonly activeScansIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class NativeFleetService {
  private readonly hostname: string;
  private readonly manifestPath: string | undefined;
  private readonly enableBackgroundPolling: boolean;
  private readonly activeScansIntervalMs: number;

  private readonly hostSampler: NativeHostSampler;
  private readonly serversScanner: NativeServersScanner;
  private readonly sessionsScanner: NativeSessionsScanner;
  private readonly ciHosts: NativeCiHosts;
  private readonly remoteProber: RemoteNodeProber;
  private readonly githubAuditPath: string;
  private readonly now: () => number;
  private readonly worktrees: FleetCachedPanel<FleetWorktreesPanel | null>;
  private readonly onProcessTable: NativeFleetServiceDeps["onProcessTable"];
  private lastForwardedTable: ReadonlyArray<ParsedPsProcess> | null = null;

  private readonly activeListeners = new Set<FleetSseListener>();
  private readonly passiveListeners = new Set<FleetSseListener>();
  private readonly actions: FleetActionTracker;
  private readonly kickedNodes = new Map<
    string,
    { readonly expiresAt: number; lastProbedAt: number }
  >();

  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private activeHostTimer: ReturnType<typeof setInterval> | null = null;
  private activeScansTimer: ReturnType<typeof setInterval> | null = null;
  private lastWorkloadScanAt = 0;
  private closed = false;
  private samplingLocal = false;
  private scanningLocal = false;
  private probingRemotes = false;

  constructor(deps: NativeFleetServiceDeps = {}) {
    this.hostname = deps.hostname ?? NodeOS.hostname();
    const stateDir = deps.stateDir ?? defaultT3StateDir();
    this.manifestPath = deps.manifestPath;
    this.enableBackgroundPolling = deps.enableBackgroundPolling ?? true;
    this.activeScansIntervalMs = deps.activeScansIntervalMs ?? ACTIVE_SCANS_INTERVAL_MS;

    const platform = deps.platform ?? "linux";
    this.hostSampler = new NativeHostSampler({
      hostname: this.hostname,
      platform,
      readHostResources: deps.readHostResources,
      readDesktopPower: deps.readDesktopPower,
    });
    this.serversScanner = new NativeServersScanner(platform);
    this.sessionsScanner = new NativeSessionsScanner(platform);
    this.ciHosts = new NativeCiHosts({
      stateFile: NodePath.join(stateDir, "hosts-check.json"),
      queueRoot: deps.queueRoot,
      manifestPath: this.manifestPath,
      repoDirs: deps.repoDirs,
    });
    this.remoteProber = new RemoteNodeProber({
      listPeerLinks: deps.listPeerLinks,
    });
    this.actions = new FleetActionTracker((act) => this.emit("action", act));
    this.githubAuditPath = deps.githubAuditPath ?? defaultGitHubAuditPath();
    this.now = deps.now ?? (() => Date.now());
    this.onProcessTable = deps.onProcessTable;
    const readWorktrees = deps.readWorktrees ?? (async () => null);
    this.worktrees = new FleetCachedPanel({
      load: readWorktrees,
      ttlMs: WORKTREES_TTL_MS,
      now: deps.now,
      initial: null,
      onUpdate: (panel) => this.emit("worktrees", panel),
    });

    if (this.enableBackgroundPolling) {
      this.startBackgroundLoop();
    }
  }

  private startBackgroundLoop(): void {
    void this.tickBackground().catch(() => undefined);
    this.bgTimer = setInterval(() => {
      void this.tickBackground().catch(() => undefined);
    }, BACKGROUND_INTERVAL_MS);
    this.bgTimer.unref();
  }

  private async tickBackground(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.activeListeners.size === 0) {
        await this.sampleLocalHost(false);
        await this.scanLocalWorkloads(false);
      }
      await this.probeAllRemotes();
    } catch {
      // keep background telemetry loop resilient
    }
  }

  private ensureActiveLoops(): void {
    if (this.closed || this.activeListeners.size === 0) return;
    if (!this.activeHostTimer) {
      void this.sampleLocalHost(true).catch(() => undefined);
      this.activeHostTimer = setInterval(() => {
        void this.sampleLocalHost(true).catch(() => undefined);
        void this.tickKickedRemotes().catch(() => undefined);
      }, ACTIVE_HOST_INTERVAL_MS);
      this.activeHostTimer.unref();
    }
    if (!this.activeScansTimer) {
      void this.scanLocalWorkloads(true).catch(() => undefined);
      void this.probeAllRemotes().catch(() => undefined);
      this.activeScansTimer = setInterval(() => {
        void this.scanLocalWorkloads(true).catch(() => undefined);
        // Past its TTL this starts a refresh whose result reaches open streams as "worktrees".
        this.worktrees.peek();
      }, this.activeScansIntervalMs);
      this.activeScansTimer.unref();
    }
  }

  private stopActiveLoopsIfIdle(): void {
    if (this.activeListeners.size > 0) return;
    if (this.activeHostTimer) {
      clearInterval(this.activeHostTimer);
      this.activeHostTimer = null;
    }
    if (this.activeScansTimer) {
      clearInterval(this.activeScansTimer);
      this.activeScansTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    if (this.activeHostTimer) {
      clearInterval(this.activeHostTimer);
      this.activeHostTimer = null;
    }
    if (this.activeScansTimer) {
      clearInterval(this.activeScansTimer);
      this.activeScansTimer = null;
    }
    this.activeListeners.clear();
    this.passiveListeners.clear();
  }

  private emit(eventName: string, payload: unknown): void {
    for (const fn of this.activeListeners) {
      try {
        fn(eventName, payload);
      } catch {
        // isolate subscriber errors
      }
    }
    if (eventName === "sessions" || eventName === "hosts" || eventName === "action") {
      for (const fn of this.passiveListeners) {
        try {
          fn(eventName, payload);
        } catch {
          // isolate subscriber errors
        }
      }
    }
  }

  private async sampleLocalHost(preferFastLinux: boolean): Promise<void> {
    if (this.closed || this.samplingLocal) return;
    this.samplingLocal = true;
    try {
      const sample = await this.hostSampler.sample({ preferFastLinux });
      this.emit("host", sample.host);
      this.emit("nodes", this.getNodesMap());
    } catch {
      // isolate OS read failures
    } finally {
      this.samplingLocal = false;
    }
  }

  private async scanLocalWorkloads(includeStats: boolean): Promise<void> {
    if (this.closed || this.scanningLocal) return;
    this.scanningLocal = true;
    try {
      const [servers, sessions] = await Promise.all([
        this.serversScanner.scan({ includeStats }),
        this.sessionsScanner.scan(),
      ]);
      this.lastWorkloadScanAt = Date.now();
      this.forwardProcessTable();
      this.emit("servers", servers);
      this.emit("sessions", sessions);
      this.emit("alerts", this.getAlerts());
      this.emit("nodes", this.getNodesMap());
    } catch {
      // isolate workload scan failures
    } finally {
      this.scanningLocal = false;
    }
  }

  private forwardProcessTable(): void {
    const table = this.sessionsScanner.getLatestProcessTable();
    if (table === this.lastForwardedTable) return;
    this.lastForwardedTable = table;
    try {
      this.onProcessTable?.(table);
    } catch {
      // isolate subscriber errors
    }
  }

  private async ensureRecentWorkloadScan(): Promise<void> {
    if (Date.now() - this.lastWorkloadScanAt < ON_DEMAND_SCAN_TTL_MS) return;
    await this.scanLocalWorkloads(false);
  }

  private async probeAllRemotes(): Promise<void> {
    if (this.closed || this.probingRemotes) return;
    const manifest = readCiHostsManifest(this.manifestPath);
    if (manifest.length === 0) return;
    this.probingRemotes = true;
    try {
      await this.remoteProber.probeManifest(manifest, this.hostname);
      this.emit("nodes", this.getNodesMap());
    } catch {
      // isolate remote probe errors
    } finally {
      this.probingRemotes = false;
    }
  }

  private async tickKickedRemotes(): Promise<void> {
    const now = Date.now();
    const manifest = readCiHostsManifest(this.manifestPath);
    for (const [name, lease] of this.kickedNodes) {
      if (lease.expiresAt <= now) {
        this.kickedNodes.delete(name);
        continue;
      }
      if (now - lease.lastProbedAt < KICK_MIN_INTERVAL_MS) continue;
      lease.lastProbedAt = now;
      const hostEntry = manifest.find((h) => h.name === name);
      const sshAlias = hostEntry?.ssh ?? (manifest.some((h) => h.on === name) ? name : null);
      if (!sshAlias) continue;
      void this.remoteProber
        .probeTarget({ name, ssh: sshAlias, note: hostEntry?.note })
        .then(() => {
          this.emit("nodes", this.getNodesMap());
        })
        .catch(() => undefined);
    }
  }

  kickNode(hostName: string): { readonly ok: boolean } {
    const now = Date.now();
    const existing = this.kickedNodes.get(hostName);
    this.kickedNodes.set(hostName, {
      expiresAt: now + KICK_LEASE_MS,
      lastProbedAt: existing?.lastProbedAt ?? 0,
    });
    void this.tickKickedRemotes().catch(() => undefined);
    return { ok: true };
  }

  private buildLocalHostFallback(forRouting = false): FleetHostTelemetry {
    return buildLocalHostTelemetry(this.hostname, this.hostSampler, forRouting);
  }

  getSelfNodeState(options?: SelfNodeOptions): FleetNodeState {
    return buildSelfNodeState(
      {
        hostname: this.hostname,
        hostSampler: this.hostSampler,
        servers: this.serversScanner.getLatest(),
        sessions: this.sessionsScanner.getLatest(),
      },
      options,
    );
  }

  async readFreshSelfNodeState(): Promise<FleetNodeState> {
    if (!this.hostSampler.getLatest()) {
      await this.sampleLocalHost(false);
    }
    // Peers read hot processes from here, so a stale scan refreshes first (TTL-bounded).
    await this.ensureRecentWorkloadScan();
    return this.getSelfNodeState({ includeSessions: true, redactPeer: true, forRouting: false });
  }

  getNodesMap(forRouting = false): Readonly<Record<string, FleetNodeState>> {
    const remote = this.remoteProber.getCachedNodes(forRouting);
    return {
      [this.hostname]: this.getSelfNodeState({
        includeSessions: !forRouting,
        redactPeer: false,
        forRouting,
      }),
      ...remote,
    };
  }

  /** In-memory telemetry provider for `@t3tools/ship-queue/ciRouter` (replaces legacy `fleet-nodes.json`). */
  getTelemetryProvider(): FleetTelemetryProvider {
    return {
      getNodesMap: () => this.getNodesMap(true),
      getLocalPower: () => {
        const latest = this.hostSampler.getLatest();
        if (!latest?.power.power) return { onBattery: "unknown" };
        return { onBattery: latest.power.power === "battery" ? "true" : "false" };
      },
    };
  }

  async getSnapshot(requestedPanels?: ReadonlySet<string>): Promise<Record<string, unknown>> {
    if (!this.hostSampler.getLatest()) {
      await this.sampleLocalHost(false);
    }
    const wants = (panel: keyof FleetSnapshot) =>
      !requestedPanels || requestedPanels.size === 0 || requestedPanels.has(panel);
    if (wants("servers") || wants("sessions") || wants("alerts")) {
      await this.ensureRecentWorkloadScan();
    }
    const full: FleetSnapshot = {
      host: this.buildLocalHostFallback(false),
      servers: this.serversScanner.getLatest(),
      sessions: this.sessionsScanner.getLatest(),
      nodes: this.getNodesMap(false),
      hosts: this.ciHosts.getPanel(),
      alerts: this.getAlerts(),
      // A full Git and pull-request pass can be slow; the "worktrees" event carries the result.
      worktrees: wants("worktrees") ? this.worktrees.peek() : null,
    };
    if (!requestedPanels || requestedPanels.size === 0) {
      return full as unknown as Record<string, unknown>;
    }
    const filtered: Record<string, unknown> = {};
    for (const key of requestedPanels) {
      if (key in full) {
        filtered[key] = full[key as keyof FleetSnapshot];
      }
    }
    return filtered;
  }

  getAlerts(): FleetAlertsPanel {
    const nowMs = this.now();
    return buildFleetAlertsPanel({
      servers: this.serversScanner.getLatest(),
      portShadows: this.serversScanner.getPortShadows(),
      githubAuditPath: this.githubAuditPath,
      nowMs,
      toolDrift: this.ciHosts.getToolDriftReport(new Date(nowMs).toISOString()),
    });
  }

  async getServers(): Promise<ReadonlyArray<unknown>> {
    await this.ensureRecentWorkloadScan();
    return this.serversScanner.getLatest();
  }

  getAction(id: string): FleetAction | null {
    return this.actions.get(id);
  }

  private emitHostsAndAlerts(): void {
    this.emit("hosts", this.ciHosts.getPanel());
    this.emit("alerts", this.getAlerts());
  }

  triggerHostsCheck(host?: string): string {
    return this.actions.start("hosts.check", host ?? "all", async () => {
      return this.ciHosts.check(host, () => this.emitHostsAndAlerts());
    });
  }

  /** The audited refusal when a turn-on lacks the confirmation its `.off` reason needs, else null. */
  refuseHostCi(host: string, enabled: boolean, request: CiToggleRequest) {
    return this.ciHosts.refuseUnconfirmedTurnOn(host, enabled, request);
  }

  triggerHostCi(host: string, enabled: boolean, request: CiToggleRequest = {}): string {
    return this.actions.start("hosts.ci", host, async () => {
      return this.ciHosts.setCi(host, enabled, () => this.emitHostsAndAlerts(), request);
    });
  }

  triggerHostProvision(host: string): string {
    return this.actions.start("hosts.provision", host, async (onProgress) => {
      return this.ciHosts.provision(host, onProgress, () => this.emitHostsAndAlerts());
    });
  }

  triggerServerAction(
    verb: "start" | "stop",
    targetId: string,
    body?: Record<string, unknown>,
  ): string {
    return this.actions.start(`server.${verb}`, targetId, async () => {
      const res = await this.serversScanner.controlServer(verb, targetId, body);
      if (res.ok) {
        await this.scanLocalWorkloads(true);
      }
      return res;
    });
  }

  triggerSessionClose(sessionId: string): string {
    return this.actions.start("session.close", sessionId, async () => {
      const res = await this.sessionsScanner.closeSession(sessionId);
      if (res.ok) {
        this.emit("sessions", this.sessionsScanner.getLatest());
        this.emit("nodes", this.getNodesMap());
      }
      return res;
    });
  }

  createEventStream(signal: AbortSignal, apiPath = "/api/events"): ReadableStream<Uint8Array> {
    return createFleetEventStream({
      signal,
      apiPath,
      activeListeners: this.activeListeners,
      passiveListeners: this.passiveListeners,
      onActiveStart: () => this.ensureActiveLoops(),
      onIdleStop: () => this.stopActiveLoopsIfIdle(),
      readInitialSnapshot: (requestedPanels) => this.getSnapshot(requestedPanels),
    });
  }
}
