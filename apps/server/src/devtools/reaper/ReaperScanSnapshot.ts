// @effect-diagnostics nodeBuiltinImport:off - Local disk-pressure snapshot for the fleet storage view; never touches network mounts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ReaperPolicyDocument } from "../ReaperPolicy.ts";
import type { StorageManifest } from "../StorageManifest.ts";
import { reapableEphemeralEntries } from "./ReaperPathGuard.ts";
import type { ReaperHostScan, ReaperScanMount } from "./ReaperTypes.ts";

const PRESSURE_PCT = 80;
const APPORT_DIR = "/var/lib/apport/coredump";

function scanMountCandidates(platform: NodeJS.Platform): ReadonlyArray<string> {
  return platform === "darwin" ? ["/System/Volumes/Data"] : ["/", "/data"];
}

async function mountUsage(mount: string): Promise<ReaperScanMount | null> {
  try {
    const st = await NodeFSP.statfs(mount);
    const total = st.blocks * st.bsize;
    if (total <= 0) return null;
    const used = (st.blocks - st.bfree) * st.bsize;
    return {
      mount,
      total_bytes: total,
      used_bytes: used,
      avail_bytes: st.bavail * st.bsize,
      used_pct: Math.round((used / total) * 1_000) / 10,
    };
  } catch {
    return null;
  }
}

async function apportCoredumps(): Promise<{ count: number; bytes: number }> {
  const totals = { count: 0, bytes: 0 };
  for (const name of await NodeFSP.readdir(APPORT_DIR).catch(() => [] as string[])) {
    const st = await NodeFSP.lstat(NodePath.join(APPORT_DIR, name)).catch(() => null);
    if (st?.isFile() === true) {
      totals.count += 1;
      totals.bytes += st.blocks * 512;
    }
  }
  return totals;
}

export async function collectHostScan(input: {
  readonly platform: NodeJS.Platform;
  readonly host: string;
  readonly scannedAt: string;
  readonly manifest: StorageManifest;
  readonly policy: ReaperPolicyDocument;
  readonly mounts?: ReadonlyArray<string>;
}): Promise<ReaperHostScan> {
  const mounts: ReaperScanMount[] = [];
  const seenDevs = new Set<number>();
  for (const mount of input.mounts ?? scanMountCandidates(input.platform)) {
    const st = await NodeFSP.stat(mount).catch(() => null);
    if (st?.isDirectory() !== true || seenDevs.has(st.dev)) continue;
    seenDevs.add(st.dev);
    const usage = await mountUsage(mount);
    if (usage !== null) mounts.push(usage);
  }
  const pressure = mounts.filter((m) => m.used_pct >= PRESSURE_PCT).map((m) => m.mount);
  return {
    schema_version: 1,
    scanned_at: input.scannedAt,
    host: input.host,
    platform: input.platform,
    mounts,
    high_pressure: pressure.length > 0,
    pressure_mounts: pressure,
    t3_manifest: {
      present: true,
      generated_at: input.manifest.generatedAt,
      history_roots: input.manifest.entries
        .filter((e) => e.trust === "history")
        .map((e) => e.path)
        .toSorted(),
      ephemeral_roots: reapableEphemeralEntries(input.manifest).map((e) => e.path),
    },
    policy: {
      path: input.policy.policyPath,
      approved_rules: input.policy.rules.filter((r) => r.enabled).length,
    },
    alerts: { apport_coredumps: await apportCoredumps() },
  };
}
