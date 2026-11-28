// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge planner runs from extracted base tree without Effect/node_modules.
// Pure target catalog, diff-based sync planning, and desktop build environment helpers for marscode-sync.
import * as NodePath from "node:path";

import {
  parseFleetState,
  planFleetSync,
  type FleetArtifactRecord,
  type FleetHostConfig,
  type FleetHostSyncRecord,
  type FleetSyncPlan,
} from "./marscode-sync-fleet-config.ts";

export type BinaryTargetKind = "vp-pack-cli" | "guard-protocol" | "host-guards";

export interface SyncBinaryTarget {
  readonly id: string;
  readonly kind: BinaryTargetKind;
  readonly binName: string;
  readonly pkgName: string;
  readonly pkgRel: string;
  readonly watchPrefixes: ReadonlyArray<string>;
  readonly stageShipQueue?: boolean;
}

export const APP_IMAGE_TARGET_ID = "desktop-appimage";

const SHARED_BUILD_FILES = ["pnpm-lock.yaml", "vite.config.ts", "tsconfig.base.json"] as const;
/** The flag-parity probes: a change to them retries every CLI that has one. */
const PARITY_PROBE_FILE = "scripts/ship/marscode-sync-parity.ts";

export const SYNC_BINARY_TARGETS: ReadonlyArray<SyncBinaryTarget> = [
  {
    id: "ship-queue",
    kind: "vp-pack-cli",
    binName: "ship-queue",
    pkgName: "@t3tools/ship-queue",
    pkgRel: "packages/ship-queue",
    watchPrefixes: [
      "packages/ship-queue/",
      "packages/guard-protocol/",
      "packages/ssh/",
      "packages/shared/",
      "packages/contracts/",
      ...SHARED_BUILD_FILES,
    ],
    stageShipQueue: true,
  },
  {
    id: "playbook",
    kind: "vp-pack-cli",
    binName: "playbook",
    pkgName: "@t3tools/playbook",
    pkgRel: "packages/playbook",
    watchPrefixes: [
      "packages/playbook/",
      "packages/fleet/",
      "packages/guard-protocol/",
      "packages/surface/",
      ...SHARED_BUILD_FILES,
    ],
  },
  {
    id: "runlog",
    kind: "vp-pack-cli",
    binName: "runlog",
    pkgName: "@t3tools/runlog",
    pkgRel: "packages/runlog",
    watchPrefixes: ["packages/runlog/", PARITY_PROBE_FILE, ...SHARED_BUILD_FILES],
  },
  {
    id: "fleet",
    kind: "vp-pack-cli",
    binName: "fleet",
    pkgName: "@t3tools/fleet",
    pkgRel: "packages/fleet",
    watchPrefixes: ["packages/fleet/", PARITY_PROBE_FILE, ...SHARED_BUILD_FILES],
  },
  {
    id: "surface",
    kind: "vp-pack-cli",
    binName: "surface",
    pkgName: "@t3tools/surface",
    pkgRel: "packages/surface",
    watchPrefixes: ["packages/surface/", PARITY_PROBE_FILE, ...SHARED_BUILD_FILES],
  },
  {
    id: "marscode-guard",
    kind: "guard-protocol",
    binName: "marscode-guard",
    pkgName: "@t3tools/guard-protocol",
    pkgRel: "packages/guard-protocol",
    watchPrefixes: ["packages/guard-protocol/"],
  },
  {
    id: "marscode-host-guard",
    kind: "host-guards",
    binName: "marscode-host-guard",
    pkgName: "@t3tools/host-guards",
    pkgRel: "packages/host-guards",
    watchPrefixes: [
      "packages/host-guards/",
      "packages/guard-protocol/",
      "packages/shared/",
      "packages/contracts/",
      ...SHARED_BUILD_FILES,
    ],
  },
];

export interface SyncState {
  readonly version: 1;
  readonly installSha?: string | undefined;
  readonly targets: Readonly<Record<string, string>>;
  /** Target id -> the probe fingerprint of a CLI skipped for no flag parity; another fingerprint retries it. */
  readonly paritySkips?: Readonly<Record<string, string>> | undefined;
  /** Latest cached linux-x64 server archive built on this host for fleet rollout. */
  readonly fleetArtifact?: FleetArtifactRecord | undefined;
  /** Per-host last synced commit and version. */
  readonly fleetHosts?: Readonly<Record<string, FleetHostSyncRecord>> | undefined;
}

export function emptySyncState(): SyncState {
  return { version: 1, targets: {} };
}

export function parseSyncState(raw: string): SyncState {
  try {
    const parsed = JSON.parse(raw) as Partial<SyncState> | null;
    if (!parsed || typeof parsed !== "object") return emptySyncState();
    const strings = (value: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim();
        }
      }
      return out;
    };
    const targets = strings(parsed.targets);
    const paritySkips = strings(parsed.paritySkips);
    return {
      version: 1,
      installSha:
        typeof parsed.installSha === "string" && parsed.installSha.trim().length > 0
          ? parsed.installSha.trim()
          : undefined,
      targets,
      ...(Object.keys(paritySkips).length > 0 ? { paritySkips } : {}),
      ...parseFleetState(parsed),
    };
  } catch {
    return emptySyncState();
  }
}

/**
 * Records the CLIs skipped for no flag parity: each is settled at HEAD with
 * its probe's fingerprint, so only a probe change (or a removed bin) retries
 * it. A skip whose probe did not run is not recorded: the next sync retries.
 */
export function recordParitySkips(
  records: {
    readonly targets: Record<string, string>;
    readonly paritySkips: Record<string, string>;
  },
  skipped: ReadonlyArray<{ readonly target: SyncBinaryTarget; readonly retry: boolean }>,
  headSha: string,
  fingerprint: (binName: string) => string,
): boolean {
  const settled = skipped.filter((s) => !s.retry);
  for (const { target } of settled) {
    records.targets[target.id] = headSha;
    records.paritySkips[target.id] = fingerprint(target.binName);
  }
  return settled.length > 0;
}

export function matchesPathPrefix(filePath: string, prefix: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return prefix.endsWith("/") ? normalized.startsWith(prefix) : normalized === prefix;
}

export function matchesBinaryTarget(target: SyncBinaryTarget, filePath: string): boolean {
  return target.watchPrefixes.some((prefix) => matchesPathPrefix(filePath, prefix));
}

const APP_IMAGE_EXACT_FILES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "vite.config.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/linux-after-pack.ts",
  "scripts/linux-glibc.ts",
  "scripts/update-release-package-versions.ts",
]);

const APP_IMAGE_EXCLUDED_PREFIXES = [
  "apps/marketing/",
  "apps/mobile/",
  "packages/runlog/",
  "packages/host-guards/",
];

const APP_IMAGE_INCLUDED_PREFIXES = ["apps/", "packages/", "native/", "assets/", "packaging/"];

export function matchesAppImageSource(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (APP_IMAGE_EXACT_FILES.has(normalized)) return true;
  if (APP_IMAGE_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return APP_IMAGE_INCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isDependencyManifestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === "pnpm-lock.yaml" ||
    normalized === "pnpm-workspace.yaml" ||
    normalized === "package.json" ||
    normalized.endsWith("/package.json")
  );
}

export type TargetDecision =
  | {
      readonly action: "build";
      readonly reason: "forced" | "missing" | "initial" | "changed" | "parity-probe-changed";
      readonly sinceSha: string | null;
    }
  | {
      readonly action: "skip";
      readonly reason:
        | "unchanged"
        | "filtered"
        | "flag-skipped"
        | "burst-coalesced"
        | "non-desktop-host";
      readonly detail?: string;
    };

export interface DesktopHostStatus {
  readonly eligible: boolean;
  readonly reason?: string;
}

export interface PlanSyncInput {
  readonly headSha: string;
  readonly state: SyncState;
  readonly existingAppSha?: string | undefined;
  readonly existingBinaries: ReadonlySet<string>;
  readonly appImageExists: boolean;
  readonly hasNodeModules: boolean;
  readonly jobsBehind: number;
  readonly force: boolean;
  readonly skipApp: boolean;
  readonly skipFleet?: boolean | undefined;
  readonly fleetHosts?: ReadonlyArray<FleetHostConfig> | undefined;
  readonly only?: ReadonlySet<string> | undefined;
  readonly desktopHost: DesktopHostStatus;
  /** Returns changed repo-relative files between `fromSha` and `headSha`, or `null` if unknown. */
  readonly listChangedFiles: (fromSha: string) => ReadonlyArray<string> | null;
  /** The current flag-parity probe fingerprint of a CLI (see marscode-sync-parity.ts). */
  readonly parityFingerprint?: ((binName: string) => string) | undefined;
}

export interface SyncPlan {
  readonly binaries: ReadonlyArray<{
    readonly target: SyncBinaryTarget;
    readonly decision: TargetDecision;
  }>;
  readonly appImage: TargetDecision;
  readonly fleet: FleetSyncPlan;
  readonly needsWorktreeUpdate: boolean;
  readonly needsInstall: boolean;
}

export function planSync(input: PlanSyncInput): SyncPlan {
  const diffCache = new Map<string, ReadonlyArray<string> | null>();
  const getChanged = (fromSha: string): ReadonlyArray<string> | null => {
    if (fromSha === input.headSha) return [];
    if (!diffCache.has(fromSha)) {
      diffCache.set(fromSha, input.listChangedFiles(fromSha));
    }
    return diffCache.get(fromSha) ?? null;
  };

  const onlySet = input.only && input.only.size > 0 ? input.only : null;

  const binaries = SYNC_BINARY_TARGETS.map((target) => {
    if (onlySet && !onlySet.has(target.id) && !onlySet.has(target.binName)) {
      return { target, decision: { action: "skip", reason: "filtered" } as const };
    }
    if (input.force) {
      return {
        target,
        decision: { action: "build", reason: "forced", sinceSha: null } as const,
      };
    }
    if (!input.existingBinaries.has(target.binName)) {
      return {
        target,
        decision: { action: "build", reason: "missing", sinceSha: null } as const,
      };
    }
    const lastSha = input.state.targets[target.id];
    if (!lastSha) {
      return {
        target,
        decision: { action: "build", reason: "initial", sinceSha: null } as const,
      };
    }
    const skippedWith = input.state.paritySkips?.[target.id];
    if (skippedWith !== undefined && skippedWith !== input.parityFingerprint?.(target.binName)) {
      return {
        target,
        decision: { action: "build", reason: "parity-probe-changed", sinceSha: lastSha } as const,
      };
    }
    const changed = getChanged(lastSha);
    if (changed === null) {
      return {
        target,
        decision: { action: "build", reason: "initial", sinceSha: lastSha } as const,
      };
    }
    if (changed.some((file) => matchesBinaryTarget(target, file))) {
      return {
        target,
        decision: { action: "build", reason: "changed", sinceSha: lastSha } as const,
      };
    }
    return { target, decision: { action: "skip", reason: "unchanged" } as const };
  });

  const appImage = planAppImageTarget(input, onlySet, getChanged);
  const fleet = planFleetSync({
    headSha: input.headSha,
    state: input.state,
    fleetHosts: input.fleetHosts ?? [],
    only: onlySet,
    skipFleet: input.skipFleet === true,
    force: input.force,
    jobsBehind: input.jobsBehind,
    desktopHost: input.desktopHost,
    getChanged,
    matchesDesktopSource: matchesAppImageSource,
  });

  const anyBinaryToBuild = binaries.some((item) => item.decision.action === "build");
  const needsWorktreeUpdate =
    anyBinaryToBuild || appImage.action === "build" || fleet.needsLinuxBuild;
  const needsNodeWorkspace =
    appImage.action === "build" ||
    fleet.needsLinuxBuild ||
    binaries.some(
      (item) => item.decision.action === "build" && item.target.kind !== "guard-protocol",
    );

  let needsInstall = false;
  if (needsNodeWorkspace) {
    if (!input.hasNodeModules || !input.state.installSha) {
      needsInstall = true;
    } else {
      const changed = getChanged(input.state.installSha);
      needsInstall = changed === null || changed.some(isDependencyManifestFile);
    }
  }

  return { binaries, appImage, fleet, needsWorktreeUpdate, needsInstall };
}

function planAppImageTarget(
  input: PlanSyncInput,
  onlySet: ReadonlySet<string> | null,
  getChanged: (fromSha: string) => ReadonlyArray<string> | null,
): TargetDecision {
  if (onlySet && !onlySet.has(APP_IMAGE_TARGET_ID) && !onlySet.has("app")) {
    return { action: "skip", reason: "filtered" };
  }
  if (input.skipApp) {
    return { action: "skip", reason: "flag-skipped" };
  }
  if (!input.desktopHost.eligible) {
    return {
      action: "skip",
      reason: "non-desktop-host",
      detail: input.desktopHost.reason ?? "host is not desktop-ready",
    };
  }
  if (!input.force && input.jobsBehind > 0) {
    return {
      action: "skip",
      reason: "burst-coalesced",
      detail: `jobs_behind=${input.jobsBehind}`,
    };
  }
  if (input.force) {
    return { action: "build", reason: "forced", sinceSha: null };
  }
  if (!input.appImageExists) {
    return { action: "build", reason: "missing", sinceSha: null };
  }
  const lastSha = input.state.targets[APP_IMAGE_TARGET_ID] ?? input.existingAppSha;
  if (!lastSha) {
    return { action: "build", reason: "initial", sinceSha: null };
  }
  const changed = getChanged(lastSha);
  if (changed === null) {
    return { action: "build", reason: "initial", sinceSha: lastSha };
  }
  if (changed.some(matchesAppImageSource)) {
    return { action: "build", reason: "changed", sinceSha: lastSha };
  }
  return { action: "skip", reason: "unchanged" };
}

export function parseGlibcVersionFromLdd(lddStdout: string): string | null {
  const firstLine = lddStdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /(\d+\.\d+)\s*$/.exec(firstLine);
  return match?.[1] ?? null;
}

export function prependPathDirs(
  existingPath: string | undefined,
  preferredDirs: ReadonlyArray<string>,
): string {
  const current = (existingPath ?? "").split(":").filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...preferredDirs, ...current]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(":");
}

export function buildDesktopArtifactEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  options: {
    readonly homeDir: string;
    readonly tmpDir: string;
    readonly hostGlibcVersion: string | null;
    readonly extraPathDirs?: ReadonlyArray<string>;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  // Host-level CARGO_TARGET_DIR redirects resource-monitor output away from build-desktop-artifact.ts.
  delete env.CARGO_TARGET_DIR;
  // Keep desktop artifact output pinned to <worktree>/release/.
  delete env.T3CODE_DESKTOP_OUTPUT_DIR;
  delete env.T3CODE_DESKTOP_MOCK_UPDATES;
  env.TMPDIR = options.tmpDir;
  env.VP_GIT_HOOKS = "0";
  if (!env.T3CODE_LINUX_GLIBC_CEILING && options.hostGlibcVersion) {
    env.T3CODE_LINUX_GLIBC_CEILING = options.hostGlibcVersion;
  }
  env.PATH = prependPathDirs(env.PATH, [
    ...(options.extraPathDirs ?? []),
    NodePath.join(options.homeDir, ".local", "share", "ship-queue-ci", "bin"),
    NodePath.join(options.homeDir, ".local", "share", "vite-plus", "bin"),
    NodePath.join(options.homeDir, ".vite-plus", "bin"),
    NodePath.join(options.homeDir, ".cargo", "bin"),
  ]);
  return env;
}
