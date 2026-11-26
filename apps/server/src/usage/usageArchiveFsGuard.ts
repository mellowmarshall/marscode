// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Process-wide cap strictly below Node's default 4-thread libuv pool so stalled SMB mounts cannot starve server FS calls.
export const MAX_GLOBAL_ARCHIVE_FS_CONCURRENCY = 2;
export const ARCHIVE_READ_CONCURRENCY = 2;
export const ARCHIVE_READ_TIMEOUT_MS = 30_000;
export const ARCHIVE_RESCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ARCHIVE_PROBE_TIMEOUT_MS = 2_000;
const ARCHIVE_OFFLINE_COOLDOWN_MS = 60_000;

export type ArchiveProbeResult =
  | { readonly accessible: true; readonly mtimeMs: number }
  | { readonly accessible: false; readonly reason: "missing" | "offline" | "timeout" | "error" };

const offlineCache = new Map<
  string,
  { readonly result: ArchiveProbeResult; readonly expiresAtMs: number }
>();
const resolvedAliases = new Map<string, Set<string>>();

let globalArchiveFsActive = 0;
let lastArchiveSlotProgressMs = 0;
const globalArchiveFsWaiting: Array<() => void> = [];

function releaseArchiveFsSlot(): void {
  // @effect-diagnostics-next-line globalDate:off
  lastArchiveSlotProgressMs = Date.now();
  const next = globalArchiveFsWaiting.shift();
  if (next === undefined) globalArchiveFsActive = Math.max(0, globalArchiveFsActive - 1);
  else next();
}

function acquireArchiveFsSlot(timeoutMs: number, label: string): Promise<void> {
  if (globalArchiveFsActive < MAX_GLOBAL_ARCHIVE_FS_CONCURRENCY) {
    globalArchiveFsActive += 1;
    // @effect-diagnostics-next-line globalDate:off
    lastArchiveSlotProgressMs = Date.now();
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = () => {
      if (settled) {
        releaseArchiveFsSlot();
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const scheduleTimeout = (delayMs: number) => {
      timer = setTimeout(() => {
        if (settled) return;
        // Only time out a queued waiter if the active slots have actually stalled with zero progress.
        // @effect-diagnostics-next-line globalDate:off
        const idleMs = Date.now() - lastArchiveSlotProgressMs;
        if (idleMs < timeoutMs) {
          scheduleTimeout(Math.max(10, timeoutMs - idleMs));
          return;
        }
        settled = true;
        const idx = globalArchiveFsWaiting.indexOf(entry);
        if (idx !== -1) globalArchiveFsWaiting.splice(idx, 1);
        reject(new Error(`${label} timed out`));
      }, delayMs);
      timer.unref?.();
    };
    scheduleTimeout(timeoutMs);
    globalArchiveFsWaiting.push(entry);
  });
}

export async function withTimeout<A>(
  promise: Promise<A>,
  timeoutMs: number,
  label: string,
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs an archive FS operation under the process-wide 2-slot cap (strictly below Node's 4-thread
 * libuv pool). The slot is released ONLY when the underlying OS call actually settles, never on
 * timeout, so a hung SMB mount can never leak more than 2 libuv threads across the process.
 */
export async function runArchiveFsOp<A>(
  fn: () => Promise<A>,
  timeoutMs: number,
  label: string,
): Promise<A> {
  await acquireArchiveFsSlot(timeoutMs, label);
  let opPromise: Promise<A>;
  try {
    opPromise = fn();
  } catch (error) {
    releaseArchiveFsSlot();
    throw error;
  }
  void opPromise.then(
    () => releaseArchiveFsSlot(),
    () => releaseArchiveFsSlot(),
  );
  return withTimeout(opPromise, timeoutMs, label);
}

/** Clears cached negative archive probes (for tests). */
export function clearArchiveProbeCache(): void {
  offlineCache.clear();
  resolvedAliases.clear();
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out");
}

function canPoisonParent(parent: string): boolean {
  if (parent === "/" || parent === NodePath.dirname(parent)) return false;
  if (parent === NodeOS.tmpdir() || parent === NodeOS.homedir()) return false;
  return parent !== "/tmp" && parent !== "/mnt" && parent !== "/home" && parent !== "/Volumes";
}

export function registerArchiveAlias(logicalDir: string, resolvedDir: string): void {
  const logical = NodePath.resolve(logicalDir);
  const resolved = NodePath.resolve(resolvedDir);
  if (logical === resolved) return;
  let set = resolvedAliases.get(resolved);
  if (set === undefined) {
    set = new Set();
    resolvedAliases.set(resolved, set);
  }
  set.add(logical);
}

export function getCachedOfflineResult(dir: string, nowMs: number): ArchiveProbeResult | undefined {
  let current = NodePath.resolve(dir);
  for (let depth = 0; depth < 8; depth += 1) {
    const cached = offlineCache.get(current);
    if (cached !== undefined) {
      if (nowMs < cached.expiresAtMs) return cached.result;
      offlineCache.delete(current);
    }
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function clearArchiveOfflinePath(normalized: string): void {
  offlineCache.delete(normalized);
  offlineCache.delete(NodePath.dirname(normalized));
  for (const alias of resolvedAliases.get(normalized) ?? []) {
    offlineCache.delete(alias);
    offlineCache.delete(NodePath.dirname(alias));
  }
}

/** True when `dir` or one of its ancestor roots is currently cached as offline/timed out. */
export function isArchivePathCachedOffline(dir: string, nowMs: number): boolean {
  return getCachedOfflineResult(dir, nowMs) !== undefined;
}

/** Records a path, its logical aliases, and (on timeout) its archive root parent as offline for the cooldown period. */
export function markArchiveOffline(
  dir: string,
  nowMs: number,
  reason: "offline" | "timeout" | "error" = "timeout",
  extraAliases?: readonly string[],
): void {
  const entry = {
    result: { accessible: false as const, reason },
    expiresAtMs: nowMs + ARCHIVE_OFFLINE_COOLDOWN_MS,
  };
  const targets = new Set<string>([NodePath.resolve(dir)]);
  for (const alias of resolvedAliases.get(NodePath.resolve(dir)) ?? []) targets.add(alias);
  for (const extra of extraAliases ?? []) targets.add(NodePath.resolve(extra));
  for (const target of targets) {
    offlineCache.set(target, entry);
    if (reason === "timeout") {
      const parent = NodePath.dirname(target);
      if (canPoisonParent(parent)) offlineCache.set(parent, entry);
    }
  }
}
