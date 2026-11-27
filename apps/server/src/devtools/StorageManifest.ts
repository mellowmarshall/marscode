// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * T3 Code's live history/ephemeral storage map: the in-process contract for ReaperService and
 * the session archive. It is also written to storage-manifest.json while hosts still run the
 * external agent-tmp-reap timer, which reads it to protect history roots.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProviderInstanceConfig, ServerSettings } from "@t3tools/contracts";

export type StorageTrustClass = "history" | "ephemeral";
export type StorageEntryKind =
  | "session-files"
  | "session-dirs"
  | "database"
  | "attachments"
  | "temp-dir"
  | "cache-dir"
  | "shell-snapshots"
  | "crashes"
  | "logs"
  | "browser-artifacts";

export interface StorageManifestEntry {
  readonly id: string;
  readonly provider: string;
  readonly instanceId: string;
  readonly trust: StorageTrustClass;
  readonly kind: StorageEntryKind;
  readonly path: string;
  readonly extensions?: ReadonlyArray<string>;
  readonly tierAction?: "move" | "protect-only";
  readonly maxAgeHours?: number;
}

export interface StorageManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly host: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly entries: ReadonlyArray<StorageManifestEntry>;
}

export interface BuildStorageManifestInput {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly browserArtifactsDir: string;
  readonly homeDir?: string;
  readonly host?: string;
  readonly now?: string;
  readonly providerInstances?: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly env?: NodeJS.ProcessEnv;
}

function expandHome(raw: string, homeDir: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function resolvePath(raw: string, homeDir: string): string {
  return NodePath.resolve(expandHome(raw, homeDir));
}

function readConfigString(config: unknown, key: string): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const val = (config as Record<string, unknown>)[key];
  return typeof val === "string" ? val.trim() : "";
}

function sha256Hex(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function envValue(instance: ProviderInstanceConfig, name: string): string {
  const entries = instance.environment;
  if (!Array.isArray(entries)) return "";
  const target = name.toUpperCase();
  for (const item of entries) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.name === "string" &&
      item.name.toUpperCase() === target &&
      typeof item.value === "string"
    ) {
      return item.value.trim();
    }
  }
  return "";
}

function defaultStorageManifestPath(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(homeDir, ".local", "state", "t3code", "storage-manifest.json");
}

export function buildStorageManifest(input: BuildStorageManifestInput): StorageManifest {
  const homeDir = input.homeDir ?? NodeOS.homedir();
  const host = (input.host ?? NodeOS.hostname()).split(".")[0] ?? "localhost";
  const env = input.env ?? process.env;
  const entries: StorageManifestEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: StorageManifestEntry) => {
    const key = `${entry.trust}:${entry.kind}:${entry.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  // 1. T3 Code core storage
  push({
    id: "t3code:state-db",
    provider: "t3code",
    instanceId: "t3code",
    trust: "history",
    kind: "database",
    path: NodePath.resolve(input.dbPath),
    tierAction: "protect-only",
  });
  push({
    id: "t3code:attachments",
    provider: "t3code",
    instanceId: "t3code",
    trust: "history",
    kind: "attachments",
    path: NodePath.resolve(input.attachmentsDir),
    tierAction: "protect-only",
  });
  push({
    id: "t3code:logs",
    provider: "t3code",
    instanceId: "t3code",
    trust: "ephemeral",
    kind: "logs",
    path: NodePath.resolve(input.logsDir),
    maxAgeHours: 168,
  });
  push({
    id: "t3code:browser-artifacts",
    provider: "t3code",
    instanceId: "t3code",
    trust: "ephemeral",
    kind: "browser-artifacts",
    path: NodePath.resolve(input.browserArtifactsDir),
    maxAgeHours: 168,
  });

  // Ensure built-in default providers are always represented even if omitted from settings.json.
  // Sort enabled instances ahead of disabled legacy instances so active drivers own canonical entry ids.
  const instances: Array<
    [
      string,
      {
        driver: string;
        enabled?: boolean;
        config?: unknown;
        environment?: ProviderInstanceConfig["environment"];
      },
    ]
  > = Object.entries(input.providerInstances ?? {})
    .map(([id, inst]): [string, ProviderInstanceConfig] => [id, inst])
    .toSorted(([, a], [, b]) => Number(a.enabled === false) - Number(b.enabled === false));

  const hasDriver = (driver: string) => instances.some(([, inst]) => inst.driver === driver);
  if (!hasDriver("codex")) instances.push(["codex", { driver: "codex", config: {} }]);
  if (!hasDriver("claudeAgent"))
    instances.push(["claudeAgent", { driver: "claudeAgent", config: {} }]);
  if (!hasDriver("antigravity"))
    instances.push(["antigravity", { driver: "antigravity", config: {} }]);

  for (const [instanceId, inst] of instances) {
    const driver = inst.driver;
    if (driver === "codex") {
      const configuredHome = readConfigString(inst.config, "homePath");
      const sharedHome = configuredHome
        ? resolvePath(configuredHome, homeDir)
        : env.CODEX_HOME?.trim()
          ? resolvePath(env.CODEX_HOME, homeDir)
          : NodePath.join(homeDir, ".codex");
      push({
        id: `codex:${instanceId}:sessions`,
        provider: "codex",
        instanceId,
        trust: "history",
        kind: "session-files",
        path: NodePath.join(sharedHome, "sessions"),
        extensions: [".jsonl", ".jsonl.zst"],
        tierAction: "move",
      });
      push({
        id: `codex:${instanceId}:archived-sessions`,
        provider: "codex",
        instanceId,
        trust: "history",
        kind: "session-files",
        path: NodePath.join(sharedHome, "archived_sessions"),
        extensions: [".jsonl", ".jsonl.zst"],
        tierAction: "move",
      });
      for (const [sub, kind, maxAgeHours] of [
        ["tmp", "temp-dir", 24],
        [".tmp", "temp-dir", 24],
        ["shell_snapshots", "shell-snapshots", 168],
        ["cache", "cache-dir", 168],
      ] as const) {
        push({
          id: `codex:${instanceId}:${sub}`,
          provider: "codex",
          instanceId,
          trust: "ephemeral",
          kind,
          path: NodePath.join(sharedHome, sub),
          maxAgeHours,
        });
      }
      const shadowHome = readConfigString(inst.config, "shadowHomePath");
      if (shadowHome) {
        const resolvedShadow = resolvePath(shadowHome, homeDir);
        push({
          id: `codex:${instanceId}:shadow-tmp`,
          provider: "codex",
          instanceId,
          trust: "ephemeral",
          kind: "temp-dir",
          path: NodePath.join(resolvedShadow, "tmp"),
          maxAgeHours: 24,
        });
      }
      continue;
    }

    if (driver === "claudeAgent") {
      const configuredHome = readConfigString(inst.config, "homePath");
      const claudeHome = configuredHome
        ? resolvePath(configuredHome, homeDir)
        : env.CLAUDE_CONFIG_DIR?.trim()
          ? resolvePath(env.CLAUDE_CONFIG_DIR, homeDir)
          : NodePath.join(homeDir, ".claude");
      push({
        id: `claudeAgent:${instanceId}:projects`,
        provider: "claudeAgent",
        instanceId,
        trust: "history",
        kind: "session-files",
        path: NodePath.join(claudeHome, "projects"),
        extensions: [".jsonl"],
        tierAction: "move",
      });
      push({
        id: `claudeAgent:${instanceId}:shell-snapshots`,
        provider: "claudeAgent",
        instanceId,
        trust: "ephemeral",
        kind: "shell-snapshots",
        path: NodePath.join(claudeHome, "shell-snapshots"),
        maxAgeHours: 168,
      });
      push({
        id: `claudeAgent:${instanceId}:debug`,
        provider: "claudeAgent",
        instanceId,
        trust: "ephemeral",
        kind: "temp-dir",
        path: NodePath.join(claudeHome, "debug"),
        maxAgeHours: 168,
      });
      continue;
    }

    if (driver === "antigravity") {
      const key = sha256Hex(instanceId);
      const profileDir = NodePath.join(input.stateDir, "providers", "antigravity", key);
      const acpDir = NodePath.join(profileDir, "antigravity-acp");
      const runtimeTemp = NodePath.join(input.stateDir, "antigravity-tmp", key.slice(0, 12));
      push({
        id: `antigravity:${instanceId}:brain`,
        provider: "antigravity",
        instanceId,
        trust: "history",
        kind: "session-dirs",
        path: NodePath.join(acpDir, "brain"),
        tierAction: "move",
      });
      push({
        id: `antigravity:${instanceId}:conversations`,
        provider: "antigravity",
        instanceId,
        trust: "history",
        kind: "database",
        path: NodePath.join(acpDir, "conversations"),
        tierAction: "protect-only",
      });
      push({
        id: `antigravity:${instanceId}:runtime-temp`,
        provider: "antigravity",
        instanceId,
        trust: "ephemeral",
        kind: "temp-dir",
        path: runtimeTemp,
        maxAgeHours: 24,
      });
      for (const [sub, kind, maxAgeHours] of [
        ["tmp", "temp-dir", 24],
        ["cache", "cache-dir", 168],
        ["crashes", "crashes", 168],
      ] as const) {
        push({
          id: `antigravity:${instanceId}:${sub}`,
          provider: "antigravity",
          instanceId,
          trust: "ephemeral",
          kind,
          path: NodePath.join(acpDir, sub),
          maxAgeHours,
        });
      }
      continue;
    }

    if (driver === "acpRegistry") {
      const fullInst = inst as ProviderInstanceConfig;
      const geminiHome = envValue(fullInst, "GEMINI_HOME");
      if (geminiHome) {
        const resolved = resolvePath(geminiHome, homeDir);
        const acpDir = NodePath.join(resolved, "antigravity-acp");
        push({
          id: `acpRegistry:${instanceId}:brain`,
          provider: "acpRegistry",
          instanceId,
          trust: "history",
          kind: "session-dirs",
          path: NodePath.join(acpDir, "brain"),
          tierAction: "move",
        });
        push({
          id: `acpRegistry:${instanceId}:conversations`,
          provider: "acpRegistry",
          instanceId,
          trust: "history",
          kind: "database",
          path: NodePath.join(acpDir, "conversations"),
          tierAction: "protect-only",
        });
      }
      const tmpDir = envValue(fullInst, "TMPDIR");
      if (tmpDir) {
        push({
          id: `acpRegistry:${instanceId}:tmp`,
          provider: "acpRegistry",
          instanceId,
          trust: "ephemeral",
          kind: "temp-dir",
          path: resolvePath(tmpDir, homeDir),
          maxAgeHours: 24,
        });
      }
    }
  }

  // Standalone Antigravity CLI home if present on disk.
  const cliAgy = NodePath.join(homeDir, ".gemini", "antigravity-cli");
  push({
    id: "antigravity-cli:default:brain",
    provider: "antigravity-cli",
    instanceId: "default",
    trust: "history",
    kind: "session-dirs",
    path: NodePath.join(cliAgy, "brain"),
    tierAction: "move",
  });
  push({
    id: "antigravity-cli:default:conversations",
    provider: "antigravity-cli",
    instanceId: "default",
    trust: "history",
    kind: "database",
    path: NodePath.join(cliAgy, "conversations"),
    tierAction: "protect-only",
  });

  return {
    schemaVersion: 1,
    generatedAt: input.now ?? new Date().toISOString(),
    host,
    baseDir: NodePath.resolve(input.baseDir),
    stateDir: NodePath.resolve(input.stateDir),
    worktreesDir: NodePath.resolve(input.worktreesDir),
    entries,
  };
}

const lastManifestHashByPath = new Map<string, string>();

function manifestContentDigest(manifest: StorageManifest): string {
  const stable = {
    schemaVersion: manifest.schemaVersion,
    host: manifest.host,
    baseDir: manifest.baseDir,
    stateDir: manifest.stateDir,
    worktreesDir: manifest.worktreesDir,
    entries: manifest.entries,
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export async function writeStorageManifest(
  manifest: StorageManifest,
  manifestPath: string = defaultStorageManifestPath(),
): Promise<string> {
  const dir = NodePath.dirname(manifestPath);
  await NodeFSP.mkdir(dir, { recursive: true });
  const tmpPath = NodePath.join(dir, `.storage-manifest.${process.pid}.${Date.now()}.tmp`);
  try {
    await NodeFSP.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await NodeFSP.rename(tmpPath, manifestPath);
    lastManifestHashByPath.set(manifestPath, manifestContentDigest(manifest));
  } catch (err) {
    await NodeFSP.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return manifestPath;
}

export async function writeStorageManifestIfChanged(
  manifest: StorageManifest,
  manifestPath: string = defaultStorageManifestPath(),
): Promise<string> {
  const digest = manifestContentDigest(manifest);
  if (lastManifestHashByPath.get(manifestPath) === digest && NodeFS.existsSync(manifestPath)) {
    return manifestPath;
  }
  return await writeStorageManifest(manifest, manifestPath);
}

export function buildStorageManifestFromSettings(
  config: Pick<
    BuildStorageManifestInput,
    | "baseDir"
    | "stateDir"
    | "worktreesDir"
    | "dbPath"
    | "attachmentsDir"
    | "logsDir"
    | "browserArtifactsDir"
  >,
  settings: Pick<ServerSettings, "providerInstances">,
): StorageManifest {
  return buildStorageManifest({
    ...config,
    providerInstances: settings.providerInstances,
  });
}
