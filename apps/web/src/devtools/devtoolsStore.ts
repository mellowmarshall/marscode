/**
 * Selector-aware external store for the unified Fleet Console and pending guard overrides.
 */
import { useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import type { GuardBrokerEvent, PendingGuardRequest } from "./devtoolsClient";
import { readDefaultFleetConsoleTab } from "./devtoolsPreferences";

export type { GuardBrokerEvent, PendingGuardRequest } from "./devtoolsClient";

export type FleetConsoleSection = "machines" | "reaper";

export interface ConsoleActionFeedback {
  readonly tone: "ok" | "error" | "busy";
  readonly text: string;
}

export interface FleetGuardRequest {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly request: PendingGuardRequest;
}

export interface DevtoolsState {
  readonly consoleOpen: boolean;
  readonly consoleSection: FleetConsoleSection;
  readonly selectedHost: string | null;
  readonly selectedJobId: string | null;
  readonly selectedEnvId: EnvironmentId | null;
  readonly pendingByEnv: ReadonlyMap<EnvironmentId, ReadonlyArray<FleetGuardRequest>>;
  readonly totalPendingCount: number;
}

let state: DevtoolsState = {
  consoleOpen: false,
  consoleSection: "machines",
  selectedHost: null,
  selectedJobId: null,
  selectedEnvId: null,
  pendingByEnv: new Map(),
  totalPendingCount: 0,
};

const listeners = new Set<() => void>();

function countTotalPending(
  pendingByEnv: ReadonlyMap<EnvironmentId, ReadonlyArray<FleetGuardRequest>>,
): number {
  let total = 0;
  for (const list of pendingByEnv.values()) {
    total += list.length;
  }
  return total;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDevtoolsSelector<T>(selector: (snapshot: DevtoolsState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function toggleFleetConsole(): void {
  const nextOpen = !state.consoleOpen;
  state = {
    ...state,
    consoleOpen: nextOpen,
    ...(nextOpen ? { consoleSection: readDefaultFleetConsoleTab() } : {}),
  };
  notify();
}

export function openFleetConsole(opts?: {
  readonly section?: FleetConsoleSection;
  readonly host?: string | null;
  readonly jobId?: string | null;
  readonly envId?: EnvironmentId | null;
}): void {
  state = {
    ...state,
    consoleOpen: true,
    consoleSection: opts?.section ?? state.consoleSection,
    ...(opts?.host !== undefined ? { selectedHost: opts.host } : {}),
    ...(opts?.jobId !== undefined ? { selectedJobId: opts.jobId } : {}),
    ...(opts?.envId !== undefined ? { selectedEnvId: opts.envId } : {}),
  };
  notify();
}

export function closeFleetConsole(): void {
  if (!state.consoleOpen) return;
  state = { ...state, consoleOpen: false };
  notify();
}

export function setConsoleSection(section: FleetConsoleSection): void {
  if (state.consoleSection === section) return;
  state = { ...state, consoleSection: section };
  notify();
}

export function setConsoleHost(host: string | null): void {
  if (state.selectedHost === host) return;
  state = { ...state, selectedHost: host };
  notify();
}

export function setConsoleJobId(jobId: string | null): void {
  if (state.selectedJobId === jobId) return;
  state = { ...state, selectedJobId: jobId };
  notify();
}

export function clearPendingGuardsForEnv(environmentId: EnvironmentId): void {
  if (!state.pendingByEnv.has(environmentId)) return;
  const next = new Map(state.pendingByEnv);
  next.delete(environmentId);
  state = { ...state, pendingByEnv: next, totalPendingCount: countTotalPending(next) };
  notify();
}

export function applyGuardBrokerEvent(
  environmentId: EnvironmentId,
  environmentLabel: string,
  event: GuardBrokerEvent,
): ReadonlyArray<PendingGuardRequest> {
  const existing = state.pendingByEnv.get(environmentId) ?? [];
  const added: PendingGuardRequest[] = [];

  if (event.type === "snapshot") {
    if (event.pending.length === 0 && existing.length === 0) {
      return added;
    }
    const existingIds = new Set(existing.map((e) => e.request.requestId));
    for (const req of event.pending) {
      if (!existingIds.has(req.requestId)) added.push(req);
    }
    const next = new Map(state.pendingByEnv);
    if (event.pending.length === 0) {
      next.delete(environmentId);
    } else {
      next.set(
        environmentId,
        event.pending.map((request) => ({ environmentId, environmentLabel, request })),
      );
    }
    state = { ...state, pendingByEnv: next, totalPendingCount: countTotalPending(next) };
    notify();
    return added;
  }

  if (event.type === "pending_added") {
    const withoutDup = existing.filter((e) => e.request.requestId !== event.request.requestId);
    if (withoutDup.length === existing.length) {
      added.push(event.request);
    }
    const next = new Map(state.pendingByEnv);
    next.set(environmentId, [
      ...withoutDup,
      { environmentId, environmentLabel, request: event.request },
    ]);
    state = { ...state, pendingByEnv: next, totalPendingCount: countTotalPending(next) };
    notify();
    return added;
  }

  if (event.type === "pending_resolved") {
    const remaining = existing.filter((e) => e.request.requestId !== event.requestId);
    if (remaining.length === existing.length) {
      return added;
    }
    const next = new Map(state.pendingByEnv);
    if (remaining.length === 0) {
      next.delete(environmentId);
    } else {
      next.set(environmentId, remaining);
    }
    state = { ...state, pendingByEnv: next, totalPendingCount: countTotalPending(next) };
    notify();
    return added;
  }

  return added;
}

export function removePendingGuard(environmentId: EnvironmentId, requestId: string): void {
  const existing = state.pendingByEnv.get(environmentId);
  if (!existing) return;
  const remaining = existing.filter((e) => e.request.requestId !== requestId);
  if (remaining.length === existing.length) return;
  const next = new Map(state.pendingByEnv);
  if (remaining.length === 0) {
    next.delete(environmentId);
  } else {
    next.set(environmentId, remaining);
  }
  state = {
    ...state,
    pendingByEnv: next,
    totalPendingCount: countTotalPending(next),
  };
  notify();
}

export function pruneExpiredGuards(nowMs = Date.now()): void {
  let changed = false;
  const next = new Map<EnvironmentId, ReadonlyArray<FleetGuardRequest>>();
  for (const [envId, list] of state.pendingByEnv.entries()) {
    const kept = list.filter((item) => {
      const exp = Date.parse(item.request.expiresAt);
      const alive = !Number.isFinite(exp) || exp > nowMs;
      if (!alive) {
        changed = true;
      }
      return alive;
    });
    if (kept.length > 0) {
      next.set(envId, kept);
    } else if (list.length > 0) {
      changed = true;
    }
  }
  if (!changed) return;
  state = {
    ...state,
    pendingByEnv: next,
    totalPendingCount: countTotalPending(next),
  };
  notify();
}
