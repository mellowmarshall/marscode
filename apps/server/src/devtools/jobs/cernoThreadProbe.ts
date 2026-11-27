// @effect-diagnostics nodeBuiltinImport:off globalDate:off - OS-grounded probe verifying live cerno sidecar snapshots for a thread.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExternalBackgroundWorkProbe } from "../../orchestration-v2/ExternalBackgroundWorkProbe.ts";
import {
  defaultCernoSnapshotDirs,
  defaultIsPidAlive,
  isCernoProcessPid,
  isSafeCernoSnapshotDir,
  readCernoSnapshotFile,
  readProcStartTicks,
  resolveThreadIdForPid,
} from "./cernoSnapshotReader.ts";

const MAX_SCAN_ENTRIES = 512;
const MAX_SNAPSHOT_FILES = 64;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000;

export interface CernoThreadProbeOptions {
  readonly snapshotDirs?: ReadonlyArray<string> | undefined;
  readonly expectedUid?: number | null | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly maxSnapshotAgeMs?: number | undefined;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
  readonly readProcStartTicks?: ((pid: number) => Promise<number | null>) | undefined;
  readonly isCernoProcess?: ((pid: number) => Promise<boolean>) | undefined;
  readonly resolveThreadId?: ((pid: number) => Promise<string | undefined>) | undefined;
}

/**
 * Returns true if at least one verified live `cerno` process has a fresh sidecar snapshot
 * attributed to `threadId` via `/proc/<pid>/environ` `T3CODE_THREAD_ID`.
 */
export async function hasLiveCernoProcessForThread(
  threadId: string,
  options: CernoThreadProbeOptions = {},
): Promise<boolean> {
  const targetThreadId = threadId.trim();
  if (!targetThreadId) return false;

  const platform = options.platform ?? "linux";
  const snapshotDirs = options.snapshotDirs ?? defaultCernoSnapshotDirs(platform);
  const expectedUid =
    options.expectedUid !== undefined
      ? options.expectedUid
      : typeof process.getuid === "function"
        ? process.getuid()
        : null;
  const now = (options.nowMs ?? (() => Date.now()))();
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const readStartTicks = options.readProcStartTicks ?? ((pid) => readProcStartTicks(pid, platform));
  const isCernoProcess = options.isCernoProcess ?? ((pid) => isCernoProcessPid(pid, platform));
  const resolveThreadId =
    options.resolveThreadId ?? ((pid) => resolveThreadIdForPid(pid, platform));
  const enforceStartTicks = platform === "linux" || options.readProcStartTicks !== undefined;

  let filesRead = 0;
  for (const dir of snapshotDirs) {
    if (filesRead >= MAX_SNAPSHOT_FILES) break;
    if (!(await isSafeCernoSnapshotDir(dir, expectedUid))) continue;
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries.slice(0, MAX_SCAN_ENTRIES)) {
      if (filesRead >= MAX_SNAPSHOT_FILES) break;
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      filesRead += 1;

      const snap = await readCernoSnapshotFile(NodePath.join(dir, name), expectedUid);
      if (!snap) continue;
      if (now - snap.updated_at_ms > maxSnapshotAgeMs) continue;
      if (!isPidAlive(snap.pid)) continue;
      if (!(await isCernoProcess(snap.pid))) continue;

      if (snap.proc_start_ticks !== undefined && enforceStartTicks) {
        const liveTicks = await readStartTicks(snap.pid);
        if (liveTicks === null || liveTicks !== snap.proc_start_ticks) continue;
      }

      const ownerThreadId = await resolveThreadId(snap.pid);
      if (ownerThreadId === targetThreadId) {
        return true;
      }
    }
  }
  return false;
}

export const ExternalBackgroundWorkProbeLive = Layer.effect(
  ExternalBackgroundWorkProbe,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    return {
      hasLiveWorkForThread: Effect.fn("ExternalBackgroundWorkProbe.hasLiveWorkForThread")(
        (threadId) => Effect.promise(() => hasLiveCernoProcessForThread(threadId, { platform })),
      ),
    };
  }),
);
