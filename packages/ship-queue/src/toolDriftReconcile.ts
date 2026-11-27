// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Bounded, non-root automated CI host tool-drift convergence loop with per-host backoff and dedup.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveCiHostsPath } from "./ciHosts.ts";
import type { HostExecDeps } from "./hostProbe.ts";
import { provisionCiHost } from "./hostProvision.ts";
import { checkHostsToolDrift, type HostToolDrift, type ToolDriftReport } from "./toolDrift.ts";

export const DEFAULT_DRIFT_SWEEP_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MIN_RETRY_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 60 * 60_000;
export const DEFAULT_SUCCESS_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_MAX_HOSTS_PER_PASS = 2;

export interface HostReconcileState {
  readonly lastAttemptAtMs: number;
  readonly consecutiveFailures: number;
  readonly nextEligibleAtMs: number;
  readonly lastError?: string | undefined;
  readonly lastInstalledTools?: ReadonlyArray<string> | undefined;
}

export interface ToolDriftReconcilePersistedState {
  readonly schema: 1;
  readonly lastSweepAtMs: number;
  readonly hosts: Readonly<Record<string, HostReconcileState>>;
}

export interface ReconcileToolDriftInput {
  readonly queueRoot: string;
  readonly manifestPath?: string | undefined;
  readonly marscodeRoot?: string | undefined;
  readonly sourceRef?: string | undefined;
  readonly targetRepo?: string | undefined;
  readonly extraRepoDirs?:
    | ReadonlyArray<{ readonly repo?: string | undefined; readonly primary: string }>
    | undefined;
  readonly maxHostsPerPass?: number | undefined;
  readonly minRetryBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly cooldownAfterSuccessMs?: number | undefined;
  readonly force?: boolean | undefined;
  readonly freshProbe?: boolean | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
  readonly deps?: HostExecDeps | undefined;
}

export interface ReconcileToolDriftResult {
  readonly ok: boolean;
  readonly skipped?: boolean | undefined;
  readonly skipReason?: string | undefined;
  readonly before?: ToolDriftReport | undefined;
  readonly after?: ToolDriftReport | undefined;
  readonly attempted: ReadonlyArray<string>;
  readonly provisioned: ReadonlyArray<{
    readonly host: string;
    readonly tools: ReadonlyArray<string>;
  }>;
  readonly failed: ReadonlyArray<{ readonly host: string; readonly error: string }>;
  readonly skippedBackoff: ReadonlyArray<string>;
  readonly skippedInFlight: ReadonlyArray<string>;
  readonly skippedRootRequired: ReadonlyArray<{
    readonly host: string;
    readonly tools: ReadonlyArray<string>;
  }>;
  readonly error?: string | undefined;
}

const inFlightHosts = new Set<string>();

export function toolDriftReconcileStatePath(queueRoot: string): string {
  return NodePath.join(queueRoot, "hosts", "tool-drift-reconcile.json");
}

export function readToolDriftReconcileState(queueRoot: string): ToolDriftReconcilePersistedState {
  const filePath = toolDriftReconcileStatePath(queueRoot);
  if (!NodeFS.existsSync(filePath)) {
    return { schema: 1, lastSweepAtMs: 0, hosts: {} };
  }
  try {
    const raw = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const lastSweepAtMs =
      typeof raw.lastSweepAtMs === "number" && Number.isFinite(raw.lastSweepAtMs)
        ? raw.lastSweepAtMs
        : 0;
    const rawHosts =
      raw.hosts && typeof raw.hosts === "object" && !Array.isArray(raw.hosts)
        ? (raw.hosts as Record<string, unknown>)
        : {};
    const hosts: Record<string, HostReconcileState> = {};
    for (const [name, item] of Object.entries(rawHosts)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      hosts[name] = {
        lastAttemptAtMs:
          typeof rec.lastAttemptAtMs === "number" && Number.isFinite(rec.lastAttemptAtMs)
            ? rec.lastAttemptAtMs
            : 0,
        consecutiveFailures:
          typeof rec.consecutiveFailures === "number" &&
          Number.isInteger(rec.consecutiveFailures) &&
          rec.consecutiveFailures >= 0
            ? rec.consecutiveFailures
            : 0,
        nextEligibleAtMs:
          typeof rec.nextEligibleAtMs === "number" && Number.isFinite(rec.nextEligibleAtMs)
            ? rec.nextEligibleAtMs
            : 0,
        ...(typeof rec.lastError === "string" ? { lastError: rec.lastError } : {}),
        ...(Array.isArray(rec.lastInstalledTools)
          ? {
              lastInstalledTools: rec.lastInstalledTools.filter(
                (t): t is string => typeof t === "string",
              ),
            }
          : {}),
      };
    }
    return { schema: 1, lastSweepAtMs, hosts };
  } catch {
    return { schema: 1, lastSweepAtMs: 0, hosts: {} };
  }
}

function mergeAndWriteReconcileState(
  queueRoot: string,
  sweepAtMs: number,
  updatedHosts: Readonly<Record<string, HostReconcileState>>,
): void {
  const latest = readToolDriftReconcileState(queueRoot);
  const merged: ToolDriftReconcilePersistedState = {
    schema: 1,
    lastSweepAtMs: Math.max(latest.lastSweepAtMs, sweepAtMs),
    hosts: { ...latest.hosts, ...updatedHosts },
  };
  const filePath = toolDriftReconcileStatePath(queueRoot);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${NodeCrypto.randomUUID()}`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, filePath);
}

function prioritizeDriftedHosts(report: ToolDriftReport): ReadonlyArray<HostToolDrift> {
  const urgentHosts = new Set<string>();
  for (const repo of report.repos) {
    if (repo.strandedOnSingleHost || repo.zeroSatisfyingHosts) {
      for (const h of repo.driftedSameArchHosts) urgentHosts.add(h);
    }
  }
  return [...report.hosts].toSorted((a, b) => {
    const aUrgent = urgentHosts.has(a.host) ? 0 : 1;
    const bUrgent = urgentHosts.has(b.host) ? 0 : 1;
    if (aUrgent !== bUrgent) return aUrgent - bUrgent;
    if (b.affectedRepos.length !== a.affectedRepos.length) {
      return b.affectedRepos.length - a.affectedRepos.length;
    }
    return a.host.localeCompare(b.host);
  });
}

function inFlightKey(queueRoot: string, hostName: string): string {
  return `${NodePath.resolve(queueRoot)}::${hostName}`;
}

/** Shared in-flight host dedup claim used by both manual `NativeCiHosts.provision` and automated drift reconciliation. */
export function tryClaimInFlightHost(queueRoot: string, hostName: string): boolean {
  const key = inFlightKey(queueRoot, hostName);
  if (inFlightHosts.has(key)) return false;
  inFlightHosts.add(key);
  return true;
}

/** Releases a shared in-flight host dedup claim. */
export function releaseInFlightHost(queueRoot: string, hostName: string): void {
  inFlightHosts.delete(inFlightKey(queueRoot, hostName));
}

/**
 * Bounded convergence pass: installs missing user-level tools (`spec.install !== null`, `allowRoot: false`)
 * on drifted eligible CI hosts with per-host exponential backoff and in-process dedup.
 * Never bypasses owner root-grant approval for tools requiring root.
 */
export async function reconcileToolDrift(
  input: ReconcileToolDriftInput,
): Promise<ReconcileToolDriftResult> {
  const nowMs = (input.deps?.nowMs ?? (() => Date.now()))();
  const maxHosts = Math.max(1, input.maxHostsPerPass ?? DEFAULT_MAX_HOSTS_PER_PASS);
  const minBackoffMs = Math.max(1_000, input.minRetryBackoffMs ?? DEFAULT_MIN_RETRY_BACKOFF_MS);
  const maxBackoffMs = Math.max(minBackoffMs, input.maxBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS);
  const successCooldownMs = Math.max(
    0,
    input.cooldownAfterSuccessMs ?? DEFAULT_SUCCESS_COOLDOWN_MS,
  );

  const beforeRes = await checkHostsToolDrift({
    queueRoot: input.queueRoot,
    manifestPath: input.manifestPath,
    targetRepo: input.targetRepo,
    extraRepoDirs: input.extraRepoDirs,
    fresh: input.freshProbe,
    deps: input.deps,
  });
  if (!beforeRes.ok || !beforeRes.report) {
    return {
      ok: false,
      attempted: [],
      provisioned: [],
      failed: [],
      skippedBackoff: [],
      skippedInFlight: [],
      skippedRootRequired: [],
      error: beforeRes.error ?? "failed to evaluate tool drift",
    };
  }

  const state = readToolDriftReconcileState(input.queueRoot);
  const updatedHosts: Record<string, HostReconcileState> = {};
  const attempted: string[] = [];
  const provisioned: Array<{ readonly host: string; readonly tools: ReadonlyArray<string> }> = [];
  const failed: Array<{ readonly host: string; readonly error: string }> = [];
  const skippedBackoff: string[] = [];
  const skippedInFlight: string[] = [];
  const skippedRootRequired: Array<{
    readonly host: string;
    readonly tools: ReadonlyArray<string>;
  }> = [];

  for (const hostDrift of prioritizeDriftedHosts(beforeRes.report)) {
    if (hostDrift.rootRequiredTools.length > 0) {
      skippedRootRequired.push({
        host: hostDrift.host,
        tools: hostDrift.rootRequiredTools,
      });
    }
    const autoSpecs = hostDrift.missing
      .filter((m) => m.autoProvisionable)
      .map((m) => m.spec)
      .toSorted();
    if (autoSpecs.length === 0) continue;
    if (attempted.length >= maxHosts) break;

    const prevHostState = updatedHosts[hostDrift.host] ?? state.hosts[hostDrift.host];
    if (!input.force && prevHostState && nowMs < prevHostState.nextEligibleAtMs) {
      skippedBackoff.push(hostDrift.host);
      continue;
    }

    if (!tryClaimInFlightHost(input.queueRoot, hostDrift.host)) {
      skippedInFlight.push(hostDrift.host);
      continue;
    }

    attempted.push(hostDrift.host);
    try {
      const prov = await provisionCiHost({
        queueRoot: input.queueRoot,
        hostName: hostDrift.host,
        manifestPath: input.manifestPath,
        marscodeRoot: input.marscodeRoot,
        sourceRef: input.sourceRef,
        onlyTools: autoSpecs,
        allowRoot: false,
        onProgress: input.onProgress,
        deps: input.deps,
      });
      if (prov.ok) {
        const installed = prov.installedTools ?? [];
        if (installed.length > 0) {
          provisioned.push({ host: hostDrift.host, tools: installed });
        }
        updatedHosts[hostDrift.host] = {
          lastAttemptAtMs: nowMs,
          consecutiveFailures: 0,
          nextEligibleAtMs: nowMs + successCooldownMs,
          lastInstalledTools: installed,
        };
      } else {
        const failures = (prevHostState?.consecutiveFailures ?? 0) + 1;
        const backoff = Math.min(maxBackoffMs, minBackoffMs * 2 ** (failures - 1));
        failed.push({ host: hostDrift.host, error: prov.message });
        updatedHosts[hostDrift.host] = {
          lastAttemptAtMs: nowMs,
          consecutiveFailures: failures,
          nextEligibleAtMs: nowMs + backoff,
          lastError: prov.message,
        };
      }
    } finally {
      releaseInFlightHost(input.queueRoot, hostDrift.host);
    }
  }

  mergeAndWriteReconcileState(input.queueRoot, nowMs, updatedHosts);

  let afterReport = beforeRes.report;
  if (provisioned.length > 0) {
    const refreshed = await checkHostsToolDrift({
      queueRoot: input.queueRoot,
      manifestPath: input.manifestPath,
      targetRepo: input.targetRepo,
      extraRepoDirs: input.extraRepoDirs,
      fresh: false,
      deps: input.deps,
    });
    if (refreshed.ok && refreshed.report) {
      afterReport = refreshed.report;
    }
  }

  return {
    ok: failed.length === 0,
    before: beforeRes.report,
    after: afterReport,
    attempted,
    provisioned,
    failed,
    skippedBackoff,
    skippedInFlight,
    skippedRootRequired,
  };
}

/**
 * Scheduler-compatible periodic pass (`Scheduler.register`): enforces a minimum sweep cadence so
 * 5-second Scheduler ticks do zero SSH work until the drift sweep interval elapses.
 */
export async function reconcileDueToolDrift(
  input: ReconcileToolDriftInput & { readonly sweepIntervalMs?: number | undefined },
): Promise<ReconcileToolDriftResult> {
  const nowMs = (input.deps?.nowMs ?? (() => Date.now()))();
  const intervalMs = Math.max(1_000, input.sweepIntervalMs ?? DEFAULT_DRIFT_SWEEP_INTERVAL_MS);
  const state = readToolDriftReconcileState(input.queueRoot);
  if (!input.force && state.lastSweepAtMs > 0 && nowMs - state.lastSweepAtMs < intervalMs) {
    return {
      ok: true,
      skipped: true,
      skipReason: "interval",
      attempted: [],
      provisioned: [],
      failed: [],
      skippedBackoff: [],
      skippedInFlight: [],
      skippedRootRequired: [],
    };
  }
  const manifestFile = input.manifestPath?.trim() || resolveCiHostsPath();
  if (!manifestFile) {
    return {
      ok: true,
      skipped: true,
      skipReason: "no-manifest",
      attempted: [],
      provisioned: [],
      failed: [],
      skippedBackoff: [],
      skippedInFlight: [],
      skippedRootRequired: [],
    };
  }
  return reconcileToolDrift({ ...input, manifestPath: manifestFile });
}
