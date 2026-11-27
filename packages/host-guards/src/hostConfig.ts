// @effect-diagnostics nodeBuiltinImport:off - Host policy configuration loader for MarsCode host-guards.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const TEST_TMP_PREFIXES: ReadonlyArray<string> = [
  "/tmp/",
  "/var/tmp/",
  "/private/tmp/",
  "/private/var/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];

export interface ProtectedAppConfig {
  readonly name: string;
  readonly provider?: "fly" | "doppler" | string | undefined;
  readonly configPaths?: ReadonlyArray<string> | undefined;
  readonly deployDrills?: ReadonlyArray<string> | undefined;
  readonly secretDrills?: ReadonlyArray<string> | undefined;
}

export interface CloudCliPolicy {
  readonly blockDirectFlyDeploy: boolean;
  readonly blockDirectFlySecrets: boolean;
  readonly blockDirectDopplerWrites: boolean;
  readonly protectedDopplerProjects: ReadonlyArray<string>;
}

export interface HostGuardsConfig {
  readonly orgs: ReadonlyArray<string>;
  readonly exemptRepos: ReadonlySet<string>;
  readonly sourceRoot: string;
  readonly dataRoot: string;
  readonly queueRoot: string;
  readonly stateDir: string;
  readonly realGit: string;
  readonly realGh: string;
  readonly realNode: string;
  readonly trustedPathDirs: ReadonlyArray<string>;
  readonly scanRoots: ReadonlyArray<string>;
  readonly hostName: string;
  readonly overridePubkey: string;
  readonly protectedApps: ReadonlyArray<ProtectedAppConfig>;
  readonly cloudCliPolicy: CloudCliPolicy;
  readonly configPath: string;
}

export interface LoadHostConfigOptions {
  /** Programmatic config path injection (unit tests only; never populated from env vars). */
  readonly configPath?: string | undefined;
  /** Programmatic home dir override (unit tests only; production always uses OS passwd home). */
  readonly homeDir?: string | undefined;
}

export function canonicalHomeDir(): string {
  try {
    const dir = NodeOS.userInfo().homedir;
    if (dir && dir.trim()) return dir.trim();
  } catch {
    // Fall back to NodeOS.homedir when passwd lookup is unavailable.
  }
  return NodeOS.homedir();
}

function expandTilde(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return NodePath.join(homeDir, trimmed.slice(2));
  return trimmed;
}

export function safeRealpath(targetPath: string): string {
  try {
    return NodeFS.realpathSync(targetPath);
  } catch {
    return NodePath.resolve(targetPath);
  }
}

export function isTempPath(targetPath: string): boolean {
  const resolved = safeRealpath(targetPath);
  const withSlash = resolved.endsWith("/") ? resolved : `${resolved}/`;
  return TEST_TMP_PREFIXES.some((prefix) => withSlash.startsWith(prefix));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function parseProtectedApps(raw: unknown): ProtectedAppConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ProtectedAppConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const name = asString(obj.name);
    if (!name) continue;
    const provider = asString(obj.provider);
    const configPaths = asStringList(obj.configPaths);
    const deployDrills = asStringList(obj.deployDrills);
    const secretDrills = asStringList(obj.secretDrills);
    out.push({
      name,
      ...(provider ? { provider } : {}),
      ...(configPaths.length > 0 ? { configPaths } : {}),
      ...(deployDrills.length > 0 ? { deployDrills } : {}),
      ...(secretDrills.length > 0 ? { secretDrills } : {}),
    });
  }
  return out;
}

function parseCloudCliPolicy(raw: unknown): CloudCliPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      blockDirectFlyDeploy: true,
      blockDirectFlySecrets: true,
      blockDirectDopplerWrites: true,
      protectedDopplerProjects: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  return {
    blockDirectFlyDeploy: obj.blockDirectFlyDeploy !== false,
    blockDirectFlySecrets: obj.blockDirectFlySecrets !== false,
    blockDirectDopplerWrites: obj.blockDirectDopplerWrites !== false,
    protectedDopplerProjects: asStringList(obj.protectedDopplerProjects).map((p) =>
      p.toLowerCase(),
    ),
  };
}

function resolveDefaultConfigPath(homeDir: string): string {
  return NodePath.join(homeDir, ".local", "lib", "marscode", "host-guards.json");
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable config falls back to safe host defaults.
  }
  return {};
}

function resolveAbsoluteBinary(candidate: string, fallback: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !NodePath.isAbsolute(trimmed)) return fallback;
  return trimmed;
}

/**
 * Loads host-guards policy strictly from canonical OS passwd home `~/.local/lib/marscode/host-guards.json`.
 * Never honors environment variables (`MARSCODE_HOST_GUARDS_CONFIG`, `HOST_GUARDS_TEST`, or `HOME`).
 */
export function loadHostConfig(options?: LoadHostConfigOptions): HostGuardsConfig {
  const homeDir = options?.homeDir?.trim() || canonicalHomeDir();
  const configPath = options?.configPath?.trim()
    ? expandTilde(options.configPath, homeDir)
    : resolveDefaultConfigPath(homeDir);
  const raw = readJsonRecord(configPath);

  const orgList = asStringList(raw.orgs).map((org) => org.toLowerCase());
  const singleOwner = asString(raw.owner).toLowerCase();
  const orgs = Array.from(new Set([...orgList, ...(singleOwner ? [singleOwner] : [])]));

  const exemptRepos = new Set(asStringList(raw.exemptRepos).map((r) => r.toLowerCase()));

  const sourceRoot = expandTilde(asString(raw.sourceRoot) || "~/Dev", homeDir);
  const dataRoot = expandTilde(asString(raw.dataRoot) || "~/Dev-data", homeDir);
  const queueRoot = safeRealpath(
    expandTilde(asString(raw.queueRoot) || NodePath.join(dataRoot, ".ship-queue"), homeDir),
  );
  const stateDir = expandTilde(
    asString(raw.stateDir) || NodePath.join(homeDir, ".local", "state", "host-guards"),
    homeDir,
  );
  const realGit = resolveAbsoluteBinary(asString(raw.realGit), "/usr/bin/git");
  const realGh = resolveAbsoluteBinary(asString(raw.realGh), "/usr/bin/gh");
  const realNodeRaw = asString(raw.realNode);
  const realNode = realNodeRaw ? resolveAbsoluteBinary(expandTilde(realNodeRaw, homeDir), "") : "";
  const trustedPathDirs = asStringList(raw.trustedPathDirs)
    .map((dir) => expandTilde(dir, homeDir))
    .filter((dir) => NodePath.isAbsolute(dir));

  const configuredScanRoots = asStringList(raw.scanRoots).map((r) => expandTilde(r, homeDir));
  const scanRoots =
    configuredScanRoots.length > 0
      ? configuredScanRoots
      : sourceRoot === dataRoot
        ? [sourceRoot]
        : [sourceRoot, dataRoot];

  return {
    orgs,
    exemptRepos,
    sourceRoot,
    dataRoot,
    queueRoot,
    stateDir,
    realGit,
    realGh,
    realNode,
    trustedPathDirs,
    scanRoots,
    hostName: asString(raw.hostName),
    overridePubkey: asString(raw.overridePubkey),
    protectedApps: parseProtectedApps(raw.protectedApps),
    cloudCliPolicy: parseCloudCliPolicy(raw.cloudCliPolicy),
    configPath,
  };
}
