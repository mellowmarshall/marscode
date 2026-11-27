// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Native T3 Fleet Service replacing DevDeck daemon for host metrics, servers, sessions, CI hosts, SSE, and ship-queue nodes JSON.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HostPowerSnapshot, HostResourcesSnapshot } from "@t3tools/contracts";

import { FleetActionTracker } from "./FleetActionTracker.ts";
import { buildFleetAlertsPanel, defaultGitHubAuditPath } from "./FleetAlerts.ts";
import { FleetCachedPanel } from "./FleetCachedPanel.ts";
import { redactPeerServerItem } from "./FleetPeerWire.ts";
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
import { NativeSessionsScanner } from "./NativeSessionsScanner.ts";
import { type PeerLinkCandidate, RemoteNodeProber } from "./RemoteNodeProber.ts";

const ACTIVE_HOST_INTERVAL_MS = 1_000;
const ACTIVE_SCANS_INTERVAL_MS = 5_000;
const BACKGROUND_INTERVAL_MS = 30_000;
const ON_DEMAND_SCAN_TTL_MS = 15_000;
const KICK_LEASE_MS = 12_000;
const KICK_MIN_INTERVAL_MS = 4_500;
const NODES_FILE_THROTTLE_MS = 5_000;
const WORKTREES_TTL_MS = 60_000;

export interface NativeFleetServiceDeps {
  readonly hostname?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly stateDir?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly enableBackgroundPolling?: boolean | undefined;
  readonly writeNodesFile?: boolean | undefined;
  readonly readHostResources?: (() => Promise<HostResourcesSnapshot | null>) | undefined;
  readonly readDesktopPower?: (() => Promise<HostPowerSnapshot | null>) | undefined;
  readonly listPeerLinks?: (() => Promise<ReadonlyArray<PeerLinkCandidate>>) | undefined;
  readonly githubAuditPath?: string | undefined;
  readonly readWorktrees?: (() => Promise<FleetWorktreesPanel | null>) | undefined;
  /** Test seams: the active workload scan cadence and the panel-cache clock. */
  readonly activeScansIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class NativeFleetService {
  private readonly hostname: string;
  private readonly nodesFilePath: string;
  private readonly manifestPath: string | undefined;
  private readonly enableBackgroundPolling: boolean;
  private readonly activeScansIntervalMs: number;
  private readonly writeNodesFileEnabled: boolean;

  private readonly hostSampler: NativeHostSampler;
  private readonly serversScanner: NativeServersScanner;
  private readonly sessionsScanner: NativeSessionsScanner;
  private readonly ciHosts: NativeCiHosts;
  private readonly remoteProber: RemoteNodeProber;
  private readonly githubAuditPath: string;
  private readonly worktrees: FleetCachedPanel<FleetWorktreesPanel | null>;

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
  private lastNodesWriteAt = 0;
  private lastWorkloadScanAt = 0;
  private closed = false;
  private samplingLocal = false;
  private scanningLocal = false;
  private probingRemotes = false;

  constructor(deps: NativeFleetServiceDeps = {}) {
    this.hostname = deps.hostname ?? NodeOS.hostname();
    const stateDir = deps.stateDir ?? defaultT3StateDir();
    this.nodesFilePath = NodePath.join(stateDir, "fleet-nodes.json");
    this.manifestPath = deps.manifestPath;
    this.enableBackgroundPolling = deps.enableBackgroundPolling ?? true;
    this.activeScansIntervalMs = deps.activeScansIntervalMs ?? ACTIVE_SCANS_INTERVAL_MS;
    this.writeNodesFileEnabled = deps.writeNodesFile ?? true;

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
      manifestPath: this.manifestPath,
    });
    this.remoteProber = new RemoteNodeProber({
      listPeerLinks: deps.listPeerLinks,
    });
    this.actions = new FleetActionTracker((act) => this.emit("action", act));
    this.githubAuditPath = deps.githubAuditPath ?? defaultGitHubAuditPath();
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
      this.persistNodesFile(false);
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
      this.persistNodesFile(false);
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
      this.persistNodesFile(true);
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
          this.persistNodesFile(false);
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
    const latest = this.hostSampler.getLatest();
    if (latest) {
      return forRouting
        ? { ...latest.host, cpu_hist: this.hostSampler.getRouteCpuHist() }
        : latest.host;
    }
    return {
      name: this.hostname,
      uptime_s: Math.max(0, Math.floor(NodeOS.uptime())),
      cpus: Math.max(1, NodeOS.cpus().length),
      cpu_hist: [],
      mem: {
        used: Math.max(0, NodeOS.totalmem() - NodeOS.freemem()),
        total: NodeOS.totalmem(),
      },
      disks: [],
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  getSelfNodeState(options?: {
    readonly includeSessions?: boolean;
    readonly redactPeer?: boolean;
    readonly forRouting?: boolean;
  }): FleetNodeState {
    const latest = this.hostSampler.getLatest();
    const host = this.buildLocalHostFallback(options?.forRouting ?? false);
    const rawServers = this.serversScanner.getLatest();
    const servers = options?.redactPeer ? rawServers.map(redactPeerServerItem) : rawServers;
    return {
      host,
      servers,
      ...(options?.includeSessions ? { sessions: this.sessionsScanner.getLatest() } : {}),
      status: "up",
      is_local: true,
      ...(latest?.power.power ? { power: latest.power.power } : {}),
      ...(latest?.power.powerSaver ? { power_saver: true } : {}),
      updated_at: host.ts,
    };
  }

  async readFreshSelfNodeState(): Promise<FleetNodeState> {
    if (!this.hostSampler.getLatest()) {
      await this.sampleLocalHost(false);
    }
    return this.getSelfNodeState({ includeSessions: false, redactPeer: true, forRouting: false });
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

  private persistNodesFile(force: boolean): void {
    if (!this.writeNodesFileEnabled || this.closed) return;
    const now = Date.now();
    if (!force && now - this.lastNodesWriteAt < NODES_FILE_THROTTLE_MS) return;
    this.lastNodesWriteAt = now;
    try {
      NodeFS.mkdirSync(NodePath.dirname(this.nodesFilePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.nodesFilePath}.tmp.${process.pid}.${now}`;
      // Always write strict ~30s-cadence cpu_hist so ship-queue/sq_route.py's 10-sample window stays ~5m.
      NodeFS.writeFileSync(tmp, JSON.stringify(this.getNodesMap(true)), { mode: 0o600 });
      NodeFS.renameSync(tmp, this.nodesFilePath);
    } catch {
      // best-effort publish for ship-queue routing
    }
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
    return buildFleetAlertsPanel({
      servers: this.serversScanner.getLatest(),
      portShadows: this.serversScanner.getPortShadows(),
      githubAuditPath: this.githubAuditPath,
      nowMs: Date.now(),
    });
  }

  async getServers(): Promise<ReadonlyArray<unknown>> {
    await this.ensureRecentWorkloadScan();
    return this.serversScanner.getLatest();
  }

  getAction(id: string): FleetAction | null {
    return this.actions.get(id);
  }

  triggerHostsCheck(host?: string): string {
    return this.actions.start("hosts.check", host ?? "all", async () => {
      return this.ciHosts.check(host, () => this.emit("hosts", this.ciHosts.getPanel()));
    });
  }

  triggerHostCi(host: string, enabled: boolean): string {
    return this.actions.start("hosts.ci", host, async () => {
      return this.ciHosts.setCi(host, enabled, () => this.emit("hosts", this.ciHosts.getPanel()));
    });
  }

  triggerHostProvision(host: string): string {
    return this.actions.start("hosts.provision", host, async (onProgress) => {
      return this.ciHosts.provision(host, onProgress, () =>
        this.emit("hosts", this.ciHosts.getPanel()),
      );
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
