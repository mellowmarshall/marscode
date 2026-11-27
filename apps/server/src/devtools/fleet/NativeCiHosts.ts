// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Native CI hosts check, toggle, and provision runner backed directly by `@t3tools/ship-queue`.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { isSafeHostName, readCiHostEntries } from "@t3tools/ship-queue/ciHosts";
import { resolveQueueRoot } from "@t3tools/ship-queue/cli";
import {
  checkCiHosts,
  setCiHostAvailability,
  type HostExecDeps,
} from "@t3tools/ship-queue/hostProbe";
import { provisionCiHost } from "@t3tools/ship-queue/hostProvision";

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

function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    NodeFS.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    NodeFS.renameSync(tmp, filePath);
  } catch {
    // best-effort state cache write
  }
}

function parseHostsReport(raw: string): FleetHostsReport | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.hosts)) return null;
    return {
      schema: 1,
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
      ...(typeof parsed.manifest === "string" ? { manifest: parsed.manifest } : {}),
      hosts: parsed.hosts.filter((h): h is Record<string, unknown> =>
        Boolean(h && typeof h === "object"),
      ),
      ...(Array.isArray(parsed.settings) ? { settings: parsed.settings } : {}),
    };
  } catch {
    return null;
  }
}

function mergeHostReports(prev: FleetHostsReport, next: FleetHostsReport): FleetHostsReport {
  const mergedHosts = [...prev.hosts];
  for (const h of next.hosts) {
    const name = typeof h.name === "string" ? h.name : "";
    if (!name) continue;
    const idx = mergedHosts.findIndex((old) => old.name === name);
    if (idx >= 0) mergedHosts[idx] = h;
    else mergedHosts.push(h);
  }
  return { ...prev, at: next.at, hosts: mergedHosts };
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

  private report: FleetHostsReport | null = null;
  private running = "";
  private lastError = "";
  private toggled = new Map<string, ToggleRecord>();

  constructor(options?: {
    readonly stateFile?: string | undefined;
    readonly queueRoot?: string | undefined;
    readonly manifestPath?: string | undefined;
    readonly hostExecDeps?: HostExecDeps | undefined;
  }) {
    this.stateFile = options?.stateFile ?? NodePath.join(defaultT3StateDir(), "hosts-check.json");
    this.queueRoot = options?.queueRoot ?? resolveQueueRoot(process.env);
    this.manifestPath = options?.manifestPath;
    this.hostExecDeps = options?.hostExecDeps;
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
      report: this.report,
      ...(this.running ? { running: this.running } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
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

  async setCi(
    host: string,
    enabled: boolean,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host.trim();
    if (!isSafeHostName(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    const known = this.knownHostNames();
    if (known.size > 0 && !known.has(targetHost)) {
      return { ok: false, message: `${targetHost} is not a known CI host` };
    }
    const reason = "turned off in T3 Code";
    const nowIso = new Date().toISOString();
    const res = setCiHostAvailability({
      queueRoot: this.queueRoot,
      hostName: targetHost,
      enabled,
      reason,
      actor: "t3code",
      manifestPath: this.manifestPath,
      nowIso: () => nowIso,
    });
    if (!res.ok) return { ok: false, message: res.message };

    const rec: ToggleRecord = {
      at: Date.now(),
      ciOff: !enabled,
      ciOffAt: enabled ? null : nowIso,
      ciOffBy: enabled ? null : "t3code",
      ciOffReason: enabled ? null : reason,
    };
    this.toggled.set(targetHost, rec);
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
      this.running = "";
      onChanged?.();
    }
  }
}
