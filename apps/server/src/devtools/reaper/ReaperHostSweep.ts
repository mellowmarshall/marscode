// @effect-diagnostics nodeBuiltinImport:off - The reaper's file sweeps, run only on a trusted live-process scan.
import type { ReaperPolicyRule } from "../ReaperPolicy.ts";
import type { StorageManifest } from "../StorageManifest.ts";
import {
  ephemeralRootsFromEntries,
  sweepApprovedPolicy,
  sweepEphemeralRoots,
} from "./ReaperEphemeralSweep.ts";
import { PathGuard, reapableEphemeralEntries } from "./ReaperPathGuard.ts";
import { trustedScan, type ProcPathScan } from "./ReaperProcPaths.ts";
import { sweepDevExhaust, sweepTmpRoots, type SweepContext } from "./ReaperTempSweep.ts";
import type { ReaperLog } from "./ReaperTypes.ts";

export const TMP_MAX_AGE_HOURS = 24;

export interface HostSweepInput {
  readonly scan: ProcPathScan | null;
  readonly historyRoots: ReadonlyArray<string>;
  readonly manifest: StorageManifest;
  readonly policyRules: ReadonlyArray<ReaperPolicyRule>;
  readonly tmpRoots: ReadonlyArray<string>;
  readonly devRoots: ReadonlyArray<string>;
  readonly uid: number;
  readonly nowMs: number;
  readonly homeDir: string;
  readonly log: ReaperLog;
}

export interface HostSweepResult {
  /** Why nothing ran; null when the sweeps ran. */
  readonly refused: string | null;
  readonly tmp: { readonly removed: number; readonly bytes: number; readonly skipped: number };
  readonly exhaust: number;
  readonly ephemeral: number;
  readonly approved: number;
}

/**
 * Temp, exhaust, ephemeral and approved-policy sweeps. A failed scan, or one that read no
 * process but this one, would show every path as unused, so then nothing is removed.
 */
export async function sweepHost(input: HostSweepInput): Promise<HostSweepResult> {
  if (!trustedScan(input.scan)) {
    const refused =
      input.scan === null ? "the live-process scan failed" : "read no process but this one";
    input.log(`Sweeps skipped: ${refused}; nothing removed.`);
    return {
      refused,
      tmp: { removed: 0, bytes: 0, skipped: 0 },
      exhaust: 0,
      ephemeral: 0,
      approved: 0,
    };
  }
  const guard = new PathGuard([...input.scan.paths, ...input.historyRoots]);
  const sweep: SweepContext = {
    uid: input.uid,
    nowMs: input.nowMs,
    guard,
    dryRun: false,
    log: input.log,
  };
  const ephemeralCtx = { ...sweep, homeDir: input.homeDir, historyRoots: input.historyRoots };
  const tmp = await sweepTmpRoots(input.tmpRoots, sweep, TMP_MAX_AGE_HOURS);
  let exhaust = 0;
  for (const devRoot of input.devRoots) {
    exhaust += await sweepDevExhaust(devRoot, sweep, { maxAgeHours: TMP_MAX_AGE_HOURS });
  }
  const ephemeral = await sweepEphemeralRoots(
    ephemeralRootsFromEntries(reapableEphemeralEntries(input.manifest)),
    ephemeralCtx,
  );
  const approved = await sweepApprovedPolicy(input.policyRules, ephemeralCtx);
  return {
    refused: null,
    tmp: { removed: tmp.dirs + tmp.files, bytes: tmp.bytes, skipped: tmp.skippedActive },
    exhaust,
    ephemeral: ephemeral.removed,
    approved: approved.removed,
  };
}
