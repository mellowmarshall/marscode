// Pure fleet deploy config, state parsing, diff planning, and version selection for marscode-sync.
import type { SyncState, TargetDecision } from "./marscode-sync-plan.ts";

export const FLEET_ROLLOUT_TARGET_ID = "fleet-rollout";

export type FleetHostKind = "linux-x64-server" | "macos-arm64-app";

export interface FleetHostConfig {
  readonly name: string;
  readonly ssh: string;
  readonly kind: FleetHostKind;
  readonly t3Home?: string | undefined;
  readonly repo?: string | undefined;
  readonly dataRoot?: string | undefined;
  readonly appPath?: string | undefined;
}

export interface FleetArtifactRecord {
  readonly sha: string;
  readonly version: string;
  readonly archivePath: string;
}

export interface FleetHostSyncRecord {
  readonly sha: string;
  readonly version: string;
}

export interface FleetHostPlan {
  readonly host: FleetHostConfig;
  readonly decision: TargetDecision;
}

export interface FleetSyncPlan {
  readonly hosts: ReadonlyArray<FleetHostPlan>;
  readonly needsLinuxBuild: boolean;
  readonly anyHostToSync: boolean;
}

const VALID_HOST_KINDS = new Set<FleetHostKind>(["linux-x64-server", "macos-arm64-app"]);
const SAFE_SSH_TARGET = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SERVER_EXACT_FILES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "scripts/build-cli-archive.ts",
  "scripts/smoke-cli-archive.ts",
  "scripts/apply-web-brand-assets.ts",
  "scripts/update-release-package-versions.ts",
]);

const SERVER_PREFIXES = [
  "apps/server/",
  "apps/web/",
  "packages/",
  "native/resource-monitor/",
  "scripts/lib/",
];

const NON_SERVER_PACKAGE_PREFIXES = ["packages/runlog/", "packages/host-guards/"];

/** Files that change the standalone linux-x64 t3 server archive. */
export function matchesFleetServerSource(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (SERVER_EXACT_FILES.has(normalized)) return true;
  if (NON_SERVER_PACKAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return SERVER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Files that change a fleet host of the given kind. */
export function matchesFleetHostSource(
  kind: FleetHostKind,
  filePath: string,
  matchesDesktopSource: (filePath: string) => boolean,
): boolean {
  return kind === "linux-x64-server"
    ? matchesFleetServerSource(filePath)
    : matchesDesktopSource(filePath);
}

/** Parses optional persisted fleet fields from `.sync-state.json`. */
export function parseFleetState(parsed: Partial<SyncState>): {
  readonly fleetArtifact?: FleetArtifactRecord | undefined;
  readonly fleetHosts?: Readonly<Record<string, FleetHostSyncRecord>> | undefined;
} {
  const rawArtifact = parsed.fleetArtifact;
  const fleetArtifact =
    rawArtifact &&
    typeof rawArtifact.sha === "string" &&
    typeof rawArtifact.version === "string" &&
    typeof rawArtifact.archivePath === "string" &&
    rawArtifact.sha.trim().length > 0 &&
    rawArtifact.version.trim().length > 0 &&
    rawArtifact.archivePath.trim().length > 0
      ? {
          sha: rawArtifact.sha.trim(),
          version: rawArtifact.version.trim(),
          archivePath: rawArtifact.archivePath.trim(),
        }
      : undefined;
  const fleetHosts: Record<string, FleetHostSyncRecord> = {};
  if (parsed.fleetHosts && typeof parsed.fleetHosts === "object") {
    for (const [hostName, record] of Object.entries(parsed.fleetHosts)) {
      if (
        record &&
        typeof record.sha === "string" &&
        typeof record.version === "string" &&
        record.sha.trim().length > 0 &&
        record.version.trim().length > 0
      ) {
        fleetHosts[hostName] = { sha: record.sha.trim(), version: record.version.trim() };
      }
    }
  }
  return {
    ...(fleetArtifact ? { fleetArtifact } : {}),
    ...(Object.keys(fleetHosts).length > 0 ? { fleetHosts } : {}),
  };
}

/** Parses and validates local fleet-deploy.json. Throws on invalid entries so typos are never silent. */
export function parseFleetConfig(raw: string): ReadonlyArray<FleetHostConfig> {
  const parsed = JSON.parse(raw) as { readonly schema?: unknown; readonly hosts?: unknown } | null;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema !== 1 ||
    !Array.isArray(parsed.hosts)
  ) {
    throw new Error("marscode-sync: fleet-deploy.json must have schema: 1 and a hosts array");
  }
  const seenNames = new Set<string>();
  const hosts: FleetHostConfig[] = [];
  for (const entry of parsed.hosts) {
    if (!entry || typeof entry !== "object") {
      throw new Error("marscode-sync: fleet-deploy.json host entry must be an object");
    }
    const rawEntry = entry as Record<string, unknown>;
    const name = typeof rawEntry.name === "string" ? rawEntry.name.trim() : "";
    const ssh = typeof rawEntry.ssh === "string" ? rawEntry.ssh.trim() : "";
    const kind = rawEntry.kind as FleetHostKind;
    if (!SAFE_NAME.test(name)) {
      throw new Error(`marscode-sync: invalid fleet host name: ${JSON.stringify(rawEntry.name)}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`marscode-sync: duplicate fleet host name: ${name}`);
    }
    seenNames.add(name);
    if (!SAFE_SSH_TARGET.test(ssh)) {
      throw new Error(
        `marscode-sync: invalid ssh target for ${name}: ${JSON.stringify(rawEntry.ssh)}`,
      );
    }
    if (!VALID_HOST_KINDS.has(kind)) {
      throw new Error(
        `marscode-sync: unsupported kind for ${name}: ${JSON.stringify(rawEntry.kind)}`,
      );
    }
    const optionalString = (field: string): string | undefined => {
      const value = rawEntry[field];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.trim().length === 0 || /[\r\n\0]/.test(value)) {
        throw new Error(`marscode-sync: invalid ${field} for ${name}`);
      }
      return value.trim();
    };
    const t3Home = optionalString("t3Home");
    const repo = optionalString("repo");
    const dataRoot = optionalString("dataRoot");
    const appPath = optionalString("appPath");
    hosts.push({
      name,
      ssh,
      kind,
      ...(t3Home ? { t3Home } : {}),
      ...(repo ? { repo } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(appPath ? { appPath } : {}),
    });
  }
  return hosts;
}

const CORE_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

function bumpPatch(version: string): string {
  const [, major, minor, patch] = CORE_PATTERN.exec(version) ?? [];
  return `${major ?? 0}.${minor ?? 0}.${Number(patch ?? 0) + 1}`;
}

function compareCore(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Produces a strictly increasing nightly exact service version (`X.Y.Z-nightly.YYYYMMDD.N`)
 * newer than both the manifest base and the previously built fleet version.
 */
export function chooseFleetVersion(input: {
  readonly desktopVersion: string;
  readonly previousVersion?: string | undefined;
  readonly date: string;
}): string {
  const desktopBase = bumpPatch(input.desktopVersion);
  const prevMatch = input.previousVersion
    ? /^(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/.exec(input.previousVersion)
    : null;
  const prevBase = prevMatch?.[1];
  const base =
    prevBase !== undefined && compareCore(prevBase, desktopBase) > 0 ? prevBase : desktopBase;
  const sameDayAndBase = prevMatch !== null && prevBase === base && prevMatch[2] === input.date;
  const seq = sameDayAndBase ? Number(prevMatch[3]) + 1 : 1;
  return `${base}-nightly.${input.date}.${seq}`;
}

export function planFleetSync(input: {
  readonly headSha: string;
  readonly state: SyncState;
  readonly fleetHosts: ReadonlyArray<FleetHostConfig>;
  readonly only: ReadonlySet<string> | null;
  readonly skipFleet: boolean;
  readonly force: boolean;
  readonly jobsBehind: number;
  readonly desktopHost: { readonly eligible: boolean; readonly reason?: string };
  readonly getChanged: (fromSha: string) => ReadonlyArray<string> | null;
  readonly matchesDesktopSource: (filePath: string) => boolean;
}): FleetSyncPlan {
  const hosts: FleetHostPlan[] = input.fleetHosts.map((host) => {
    if (
      input.only &&
      !input.only.has(FLEET_ROLLOUT_TARGET_ID) &&
      !input.only.has("fleet") &&
      !input.only.has(host.name)
    ) {
      return { host, decision: { action: "skip", reason: "filtered" } };
    }
    if (input.skipFleet) {
      return { host, decision: { action: "skip", reason: "flag-skipped" } };
    }
    if (host.kind === "linux-x64-server" && !input.desktopHost.eligible) {
      return {
        host,
        decision: {
          action: "skip",
          reason: "non-desktop-host",
          detail: input.desktopHost.reason ?? "host cannot build linux-x64 server archive",
        },
      };
    }
    if (!input.force && input.jobsBehind > 0) {
      return {
        host,
        decision: {
          action: "skip",
          reason: "burst-coalesced",
          detail: `jobs_behind=${input.jobsBehind}`,
        },
      };
    }
    if (input.force) {
      return { host, decision: { action: "build", reason: "forced", sinceSha: null } };
    }
    const lastSha = input.state.fleetHosts?.[host.name]?.sha;
    if (!lastSha) {
      return { host, decision: { action: "build", reason: "initial", sinceSha: null } };
    }
    if (lastSha === input.headSha) {
      return { host, decision: { action: "skip", reason: "unchanged" } };
    }
    const changed = input.getChanged(lastSha);
    if (changed === null) {
      return { host, decision: { action: "build", reason: "initial", sinceSha: lastSha } };
    }
    if (
      changed.some((file) => matchesFleetHostSource(host.kind, file, input.matchesDesktopSource))
    ) {
      return { host, decision: { action: "build", reason: "changed", sinceSha: lastSha } };
    }
    return { host, decision: { action: "skip", reason: "unchanged" } };
  });

  const needsLinuxBuild = hosts.some(
    (entry) => entry.host.kind === "linux-x64-server" && entry.decision.action === "build",
  );
  const anyHostToSync = hosts.some((entry) => entry.decision.action === "build");
  return { hosts, needsLinuxBuild, anyHostToSync };
}
