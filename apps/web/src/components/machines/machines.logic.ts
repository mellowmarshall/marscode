import type { EnvironmentId, OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";

import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import type { EnvironmentPresentation } from "../../state/environments";
import type { SidebarThreadSummary } from "../../types";

export type MachinesTab = "overview" | "processes" | "jobs" | "servers";
export type MetricTone = "default" | "warning" | "danger";

export function readMachinesTab(raw: unknown): MachinesTab {
  if (raw === "processes" || raw === "jobs" || raw === "servers") return raw;
  return "overview";
}

function connectionRank(phase: EnvironmentPresentation["connection"]["phase"]): number {
  switch (phase) {
    case "connected":
      return 0;
    case "connecting":
    case "reconnecting":
      return 1;
    default:
      return 2;
  }
}

export function sortMachineEnvironments(
  environments: ReadonlyArray<EnvironmentPresentation>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentPresentation> {
  return [...environments].sort((a, b) => {
    const aPrimary = a.environmentId === primaryEnvironmentId ? 0 : 1;
    const bPrimary = b.environmentId === primaryEnvironmentId ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;

    const aConn = connectionRank(a.connection.phase);
    const bConn = connectionRank(b.connection.phase);
    if (aConn !== bConn) return aConn - bConn;

    return a.label.localeCompare(b.label);
  });
}

export function clampRatio(ratio: number | null): number | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0, ratio));
}

export function metricTone(ratio: number | null): MetricTone {
  const clamped = clampRatio(ratio);
  if (clamped === null) return "default";
  if (clamped >= 0.92) return "danger";
  if (clamped >= 0.8) return "warning";
  return "default";
}

export function formatPercent(ratio: number | null): string {
  const clamped = clampRatio(ratio);
  if (clamped === null) return "-";
  return `${Math.round(clamped * 100)}%`;
}

export function formatUptime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 1) return "<1m";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function shortMountLabel(mount: string): string {
  const trimmed = mount.trim();
  if (!trimmed || trimmed === "/") return "/";
  const windowsRoot = /^([A-Za-z]:)[\\/]?$/.exec(trimmed);
  if (windowsRoot?.[1]) return windowsRoot[1];
  const normalized = trimmed.replace(/[\\/]+$/, "");
  if (normalized.length <= 24) return normalized;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

function threadUrgencyRank(status: SidebarThreadStatus): number {
  switch (status) {
    case "approval":
    case "input":
    case "request":
      return 0;
    case "preparing":
    case "working":
      return 1;
    case "failed":
    case "limited":
      return 2;
    case "waiting":
      return 3;
    case "ready":
      return 4;
  }
}

export function selectEnvironmentThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  environmentId: EnvironmentId,
): ReadonlyArray<SidebarThreadSummary> {
  return threads
    .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
    .sort((a, b) => {
      const rankDiff =
        threadUrgencyRank(resolveSidebarThreadStatus(a)) -
        threadUrgencyRank(resolveSidebarThreadStatus(b));
      if (rankDiff !== 0) return rankDiff;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export function countEnvironmentThreadStates(
  threads: ReadonlyArray<SidebarThreadSummary>,
  environmentId: EnvironmentId,
): { readonly total: number; readonly active: number; readonly attention: number } {
  let total = 0;
  let active = 0;
  let attention = 0;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId || thread.archivedAt !== null) continue;
    total += 1;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "preparing" || status === "working") {
      active += 1;
    } else if (
      status === "approval" ||
      status === "input" ||
      status === "request" ||
      status === "failed" ||
      status === "limited"
    ) {
      attention += 1;
    }
  }
  return { total, active, attention };
}

export interface MachineBackgroundJobEntry {
  readonly key: string;
  readonly thread: SidebarThreadSummary;
  readonly task: OrchestrationV2PendingBackgroundTask;
}

export function selectEnvironmentBackgroundJobs(
  threads: ReadonlyArray<SidebarThreadSummary>,
  environmentId: EnvironmentId,
): ReadonlyArray<MachineBackgroundJobEntry> {
  const entries: Array<MachineBackgroundJobEntry> = [];
  for (const thread of threads) {
    if (thread.environmentId !== environmentId || thread.archivedAt !== null) {
      continue;
    }
    for (const task of thread.pendingBackgroundTasks) {
      entries.push({
        key: `${thread.id}:${task.taskId}`,
        thread,
        task,
      });
    }
  }
  entries.sort((left, right) => {
    const awaitedDiff = Number(right.task.awaited === true) - Number(left.task.awaited === true);
    if (awaitedDiff !== 0) return awaitedDiff;
    const updatedDiff = right.thread.updatedAt.localeCompare(left.thread.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;
    return left.key.localeCompare(right.key);
  });
  return entries;
}
