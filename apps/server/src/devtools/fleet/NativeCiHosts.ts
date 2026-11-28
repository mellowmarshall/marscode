// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native CI hosts check, toggle, and provision runner backed directly by `@t3tools/ship-queue`.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isSafeHostName,
  loadCiHostsManifest,
  readCiHostEntries,
  resolveCiHostsPath,
} from "@t3tools/ship-queue/ciHosts";
import { resolveQueueRoot } from "@t3tools/ship-queue/cli";
import { checkCiHosts, type HostExecDeps } from "@t3tools/ship-queue/hostProbe";
import { hostOffFilePath, readHostOffState } from "@t3tools/ship-queue/hostOffMarker";
import { provisionCiHost } from "@t3tools/ship-queue/hostProvision";
import { collectRepoToolRequirements } from "@t3tools/ship-queue/repoRequirements";
import {
  evaluateToolDrift,
  readCachedProbesByHost,
  type ToolDriftReport,
} from "@t3tools/ship-queue/toolDrift";
import {
  reconcileToolDrift,
  releaseInFlightHost,
  tryClaimInFlightHost,
  type ReconcileToolDriftResult,
} from "@t3tools/ship-queue/toolDriftReconcile";

import { type CiHostToggleResult, refuseUnconfirmedTurnOn, toggleCiHost } from "./CiHostToggle.ts";
import type { CiToggleRequest } from "./CiToggleAudit.ts";
import {
  atomicWriteJson,
  fileSignature,
  mergeHostReports,
  parseHostsReport,
  withLiveOffState,
} from "./CiHostsReportFile.ts";
import { probesFromHostsReport } from "./FleetToolDriftAlerts.ts";
import type { CiHostManifestEntry, FleetHostsPanel, FleetHostsReport } from "./FleetTypes.ts";

export function defaultT3StateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg || NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(base, "t3code");
}

/** Reads CI host entries through the single canonical `@t3tools/ship-queue/ciHosts` loader. */
export function readCiHostsManifest(overridePath?: string): ReadonlyArray<CiHostManifestEntry> {
  return readCiHostEntries({ overridePath }).map((entry) => ({
    name: entry.name,
    ssh: entry.ssh,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
    ...(entry.data_root ? { data_root: entry.data_root } : {}),
    ...(entry.on ? { on: entry.on } : {}),
    ...(entry.role ? { role: entry.role } : {}),
  }));
}

interface ToggleRecord {
  readonly at: number;
  readonly ciOff: boolean;
  readonly ciOffAt: string | null;
  readonly ciOffBy: string | null;
  readonly ciOffReason: string | null;
}

export class NativeCiHosts {
  private readonly stateFile: string;
  private readonly queueRoot: string;
  private readonly manifestPath: string | undefined;
  private readonly hostExecDeps: HostExecDeps | undefined;
  private readonly repoDirs:
    | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
    | undefined;

  private report: FleetHostsReport | null = null;
  private running = "";
  private lastError = "";
  private toggled = new Map<string, ToggleRecord>();
  private panelCache: {
    readonly key: string;
    readonly source: FleetHostsReport | null;
    readonly report: FleetHostsReport | null;
  } | null = null;

  constructor(options?: {
    readonly stateFile?: string | undefined;
    readonly queueRoot?: string | undefined;
    readonly manifestPath?: string | undefined;
    readonly hostExecDeps?: HostExecDeps | undefined;
    readonly repoDirs?:
      | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
      | undefined;
  }) {
    this.stateFile = options?.stateFile ?? NodePath.join(defaultT3StateDir(), "hosts-check.json");
    this.queueRoot = options?.queueRoot ?? resolveQueueRoot(process.env);
    this.manifestPath = options?.manifestPath;
    this.hostExecDeps = options?.hostExecDeps;
    this.repoDirs = options?.repoDirs;
    this.loadInitialReport();
  }

  private loadInitialReport(): void {
    try {
      const parsed = parseHostsReport(NodeFS.readFileSync(this.stateFile, "utf8"));
      if (parsed) this.report = parsed;
    } catch {
      // no persisted report yet
    }
  }

  getPanel(): FleetHostsPanel {
    return {
      report: this.reportWithManifestHosts(),
      ...(this.running ? { running: this.running } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * The Fleet console keys each host's CI switch off a report row. Until a hosts check has probed
   * a manifest host, list it with only its name so the switch still shows. Every row takes its CI
   * state from the live `.off` marker, never from the last check. Cached until the manifest or the
   * hosts directory (where `.off` markers are renamed in and removed) changes.
   */
  private reportWithManifestHosts(): FleetHostsReport | null {
    const manifestFile = this.manifestPath?.trim() || resolveCiHostsPath();
    const hostsDir = NodePath.dirname(hostOffFilePath(this.queueRoot, "_"));
    const key = `${manifestFile ?? ""}|${fileSignature(manifestFile)}|${fileSignature(hostsDir)}`;
    const cached = this.panelCache;
    if (cached && cached.key === key && cached.source === this.report) return cached.report;
    const report = this.buildReportWithManifestHosts(manifestFile ?? undefined);
    this.panelCache = { key, source: this.report, report };
    return report;
  }

  private buildReportWithManifestHosts(manifestFile: string | undefined): FleetHostsReport | null {
    const reported = new Set((this.report?.hosts ?? []).map((h) => h.name));
    const unprobed = readCiHostsManifest(manifestFile).filter((h) => !reported.has(h.name));
    if (unprobed.length === 0 && !this.report) return null;
    const base: FleetHostsReport = this.report ?? { schema: 1, at: "", hosts: [] };
    return withLiveOffState(
      base,
      this.queueRoot,
      unprobed.map((h) => ({ name: h.name, ssh: h.ssh })),
    );
  }

  private knownHostNames(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const h of readCiHostsManifest(this.manifestPath)) names.add(h.name);
    for (const h of this.report?.hosts ?? []) {
      if (typeof h.name === "string" && h.name) names.add(h.name);
    }
    return names;
  }

  private applyToggles(rep: FleetHostsReport, startedAt: number): FleetHostsReport {
    if (this.toggled.size === 0) return rep;
    const hosts = rep.hosts.map((h) => {
      const name = typeof h.name === "string" ? h.name : "";
      const tog = this.toggled.get(name);
      if (!tog || tog.at < startedAt) return h;
      return {
        ...h,
        ci_off: tog.ciOff,
        ci_off_at: tog.ciOffAt,
        ci_off_by: tog.ciOffBy,
        ci_off_reason: tog.ciOffReason,
      };
    });
    return { ...rep, hosts };
  }

  async check(
    host?: string,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host?.trim() ?? "";
    if (targetHost && !isSafeHostName(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    if (this.running) {
      return { ok: false, message: "A hosts check or provision is already running" };
    }
    this.running = targetHost ? `check ${targetHost}` : "check";
    onChanged?.();
    try {
      return await this.runCheckInternal(targetHost);
    } finally {
      this.running = "";
      onChanged?.();
    }
  }

  private async runCheckInternal(
    targetHost: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const startedAt = Date.now();
    const res = await checkCiHosts({
      queueRoot: this.queueRoot,
      manifestPath: this.manifestPath,
      targetHost: targetHost || undefined,
      deps: this.hostExecDeps,
    });
    if (!res.ok || !res.report) {
      this.lastError = `hosts check: ${res.error ?? "failed"}`;
      return { ok: false, message: this.lastError };
    }
    const wireReport: FleetHostsReport = {
      schema: 1,
      at: res.report.at,
      ...(res.report.manifest ? { manifest: res.report.manifest } : {}),
      hosts: res.report.hosts as unknown as ReadonlyArray<Record<string, unknown>>,
      settings: res.report.settings,
    };
    const merged =
      targetHost && this.report ? mergeHostReports(this.report, wireReport) : wireReport;
    const finalRep = this.applyToggles(merged, startedAt);
    this.report = finalRep;
    this.lastError = "";
    atomicWriteJson(this.stateFile, finalRep);
    return {
      ok: true,
      message: targetHost ? `Checked ${targetHost}` : "Checked all hosts",
    };
  }

  /** The audited refusal when a turn-on lacks the confirmation its `.off` reason needs, else null. */
  refuseUnconfirmedTurnOn(
    host: string,
    enabled: boolean,
    request: CiToggleRequest,
  ): CiHostToggleResult | null {
    return refuseUnconfirmedTurnOn(this.queueRoot, host, enabled, request);
  }

  async setCi(
    host: string,
    enabled: boolean,
    onChanged?: () => void,
    request: CiToggleRequest = {},
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host.trim();
    const res = toggleCiHost({
      queueRoot: this.queueRoot,
      manifestPath: this.manifestPath,
      host: targetHost,
      enabled,
      request,
      knownHosts: this.knownHostNames(),
    });
    if (!res.ok) return { ok: false, message: res.message };

    let off: ReturnType<typeof readHostOffState> = null;
    try {
      off = readHostOffState(this.queueRoot, targetHost);
    } catch {
      off = { at: "", by: "", reason: "unreadable .off marker", version: "" };
    }
    const rec: ToggleRecord = {
      at: Date.now(),
      ciOff: off !== null,
      ciOffAt: off?.at || null,
      ciOffBy: off?.by || null,
      ciOffReason: off?.reason || null,
    };
    this.toggled.set(targetHost, rec);
    this.panelCache = null;
    if (this.report) {
      this.report = this.applyToggles(this.report, 0);
      atomicWriteJson(this.stateFile, this.report);
    }
    onChanged?.();
    return { ok: true, message: res.message };
  }

  async provision(
    host: string,
    onProgress?: (line: string) => void,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host.trim();
    if (!isSafeHostName(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    if (this.running) {
      return { ok: false, message: "A hosts check or provision is already running" };
    }
    if (!tryClaimInFlightHost(this.queueRoot, targetHost)) {
      return {
        ok: false,
        message: `A provision or drift reconciliation is already running for ${targetHost}`,
      };
    }
    this.running = `provision ${targetHost}`;
    onChanged?.();
    try {
      const provRes = await provisionCiHost({
        queueRoot: this.queueRoot,
        hostName: targetHost,
        manifestPath: this.manifestPath,
        marscodeRoot: process.env.MARSCODE_ROOT?.trim() || undefined,
        onProgress,
        deps: this.hostExecDeps,
      });
      await this.runCheckInternal(targetHost);
      return provRes;
    } finally {
      releaseInFlightHost(this.queueRoot, targetHost);
      this.running = "";
      onChanged?.();
    }
  }

  /**
   * Computes a fresh eligible-host tool-drift report using hot-reloaded `ci-hosts.json`,
   * cached `<queueRoot>/hosts/*.probe` inventories (falling back to `hosts-check.json`),
   * and freshly read repository tool declarations.
   */
  getToolDriftReport(nowIso?: string): ToolDriftReport | null {
    const loaded = loadCiHostsManifest({ overridePath: this.manifestPath });
    if (!loaded.ok || !loaded.manifest) return null;
    const cachedProbes = readCachedProbesByHost(this.queueRoot, loaded.manifest);
    const reportProbes = probesFromHostsReport(this.report);
    const mergedProbes: Record<string, Readonly<Record<string, string>> | null> = {};
    let anyProbe = false;
    for (const host of loaded.manifest.hosts) {
      const probe = cachedProbes[host.name] ?? reportProbes[host.name] ?? null;
      mergedProbes[host.name] = probe;
      if (probe) anyProbe = true;
    }
    if (!anyProbe) return null;
    const repos = collectRepoToolRequirements({
      queueRoot: this.queueRoot,
      extraRepoDirs: this.repoDirs,
    });
    return evaluateToolDrift({
      queueRoot: this.queueRoot,
      manifest: loaded.manifest,
      probesByHost: mergedProbes,
      repos,
      at: nowIso ?? this.hostExecDeps?.nowIso?.() ?? this.report?.at ?? new Date().toISOString(),
    });
  }

  /** Bounded non-root convergence pass reusing `hostProvision.ts` with per-host backoff and dedup. */
  async reconcileToolDrift(options?: {
    readonly force?: boolean | undefined;
    readonly onProgress?: ((line: string) => void) | undefined;
    readonly onChanged?: (() => void) | undefined;
  }): Promise<ReconcileToolDriftResult> {
    const res = await reconcileToolDrift({
      queueRoot: this.queueRoot,
      manifestPath: this.manifestPath,
      marscodeRoot: process.env.MARSCODE_ROOT?.trim() || undefined,
      extraRepoDirs: this.repoDirs,
      force: options?.force,
      onProgress: options?.onProgress,
      deps: this.hostExecDeps,
    });
    if (res.provisioned.length > 0 && !this.running) {
      this.running = "check";
      try {
        await this.runCheckInternal("");
      } finally {
        this.running = "";
      }
      options?.onChanged?.();
    }
    return res;
  }
}
