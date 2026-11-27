// @effect-diagnostics nodeBuiltinImport:off - Generic config and fleet-shape.json driven guard for fly/flyctl and doppler writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { hasVerifiedDrillAncestor, resolveDefaultBaseRef } from "./drillTrust.ts";
import { safeRealpath, type HostGuardsConfig, type ProtectedAppConfig } from "./hostConfig.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, runHardenedGit, type RepoInfo } from "./repoScope.ts";

const FLY_BINARIES = new Set(["fly", "flyctl"]);
const FLY_SECRET_MUTATIONS = new Set(["set", "unset", "import", "deploy", "sync"]);
const FLY_WRITE_SUBS = new Set(["deploy", "scale", "machine", "machines", "config"]);
const DOPPLER_WRITE_SUBS = new Set(["set", "delete", "upload"]);
const FLY_VALUE_FLAGS = new Set([
  "-a",
  "--app",
  "-c",
  "--config",
  "-t",
  "--access-token",
  "-o",
  "--org",
  "-e",
  "--env",
  "-i",
  "--image",
  "--dockerfile",
  "--strategy",
  "--region",
  "--primary-region",
]);

interface ResolvedAppRule {
  readonly name: string;
  readonly configPaths: ReadonlySet<string>;
  readonly deployDrills: ReadonlySet<string>;
  readonly secretDrills: ReadonlySet<string>;
}

function getRecord(obj: unknown, ...keys: ReadonlyArray<string>): Record<string, unknown> {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return {};
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur && typeof cur === "object" && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : {};
}

function asStringList(val: unknown): string[] {
  if (typeof val === "string" && val.trim()) return [val.trim()];
  if (!Array.isArray(val)) return [];
  return val
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

function loadFleetProtectedApps(
  repo: RepoInfo | null,
  config: HostGuardsConfig,
): {
  readonly apps: ReadonlyArray<ResolvedAppRule>;
  readonly dopplerProjects: ReadonlySet<string>;
} {
  const byName = new Map<
    string,
    { configPaths: Set<string>; deployDrills: Set<string>; secretDrills: Set<string> }
  >();
  const dopplerProjects = new Set<string>(config.cloudCliPolicy.protectedDopplerProjects);

  const upsert = (entry: ProtectedAppConfig) => {
    const key = entry.name.toLowerCase();
    const rec = byName.get(key) ?? {
      configPaths: new Set<string>(),
      deployDrills: new Set<string>(),
      secretDrills: new Set<string>(),
    };
    for (const p of entry.configPaths ?? []) rec.configPaths.add(NodePath.posix.normalize(p));
    for (const d of entry.deployDrills ?? []) rec.deployDrills.add(NodePath.posix.normalize(d));
    for (const s of entry.secretDrills ?? []) rec.secretDrills.add(NodePath.posix.normalize(s));
    byName.set(key, rec);
  };

  for (const app of config.protectedApps) {
    upsert(app);
  }

  if (repo && repo.inScope) {
    const ref = resolveDefaultBaseRef(repo, config);
    if (ref) {
      const playbookRaw = runHardenedGit(
        repo.top,
        ["show", "--end-of-options", `${ref}:playbook.json`],
        config,
      );
      let shapeFile = "fleet-shape.json";
      if (playbookRaw) {
        try {
          const pb = JSON.parse(playbookRaw) as unknown;
          const file = getRecord(pb, "contracts", "fleet").file;
          if (typeof file === "string" && file.trim()) shapeFile = file.trim();
        } catch {
          // use default fleet-shape.json
        }
      }
      const shapeRaw = runHardenedGit(
        repo.top,
        ["show", "--end-of-options", `${ref}:${shapeFile}`],
        config,
      );
      if (shapeRaw) {
        try {
          const shape = JSON.parse(shapeRaw) as unknown;
          const apps = getRecord(shape, "apps");
          for (const [appKey, rawApp] of Object.entries(apps)) {
            const flyBlock = getRecord(rawApp, "fly");
            const deployBlock = getRecord(rawApp, "deploy");
            const secretsBlock = getRecord(rawApp, "secrets");
            const dopplerBlock = getRecord(rawApp, "doppler");

            const flyName =
              typeof flyBlock.app === "string" && flyBlock.app.trim() ? flyBlock.app.trim() : "";
            if (flyName) {
              upsert({
                name: flyName,
                provider: "fly",
                configPaths: asStringList(flyBlock.config),
                deployDrills: [
                  ...asStringList(deployBlock.drill),
                  ...asStringList(deployBlock.drills),
                  ...asStringList(flyBlock.deployDrill),
                ],
                secretDrills: [
                  ...asStringList(secretsBlock.drill),
                  ...asStringList(secretsBlock.drills),
                  ...asStringList(flyBlock.secretDrill),
                ],
              });
            }
            const dopplerProj =
              typeof dopplerBlock.project === "string" && dopplerBlock.project.trim()
                ? dopplerBlock.project.trim().toLowerCase()
                : "";
            if (dopplerProj) dopplerProjects.add(dopplerProj);
            if (
              appKey &&
              typeof rawApp === "object" &&
              rawApp !== null &&
              "dopplerProject" in rawApp
            ) {
              const dp = (rawApp as Record<string, unknown>).dopplerProject;
              if (typeof dp === "string" && dp.trim()) dopplerProjects.add(dp.trim().toLowerCase());
            }
          }
        } catch {
          // ignore malformed fleet shape
        }
      }
    }
  }

  return {
    apps: Array.from(byName.entries()).map(([name, rec]) => ({
      name,
      configPaths: rec.configPaths,
      deployDrills: rec.deployDrills,
      secretDrills: rec.secretDrills,
    })),
    dopplerProjects,
  };
}

function readFlyTomlAppName(filePath: string): {
  readonly app: string | null;
  readonly unsafe: boolean;
} {
  try {
    const lstat = NodeFS.lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
      const target = safeRealpath(filePath);
      if (target.startsWith("/proc/") || target.startsWith("/dev/")) {
        return { app: null, unsafe: true };
      }
    }
    const text = NodeFS.readFileSync(filePath, "utf8");
    const match = /^\s*app\s*=\s*["']([^"']+)["']/m.exec(text);
    return { app: match?.[1]?.trim().toLowerCase() ?? null, unsafe: false };
  } catch {
    return { app: null, unsafe: false };
  }
}

function hasSanctionedCloudDrillAncestor(
  repo: RepoInfo | null,
  allowedDrills: ReadonlySet<string>,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): boolean {
  if (!repo || !repo.inScope || allowedDrills.size === 0) return false;
  return hasVerifiedDrillAncestor({
    repo,
    allowedPaths: Array.from(allowedDrills),
    requireCleanMerged: true,
    config,
    procFs,
  });
}

function parseFlyArgs(args: ReadonlyArray<string>): {
  readonly subcommands: ReadonlyArray<string>;
  readonly appFlag: string;
  readonly configFlag: string;
} {
  const subcommands: string[] = [];
  let appFlag = "";
  let configFlag = "";
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? (args[i + 1] ?? "") : a.slice(eq + 1);
    if (flag === "-a" || flag === "--app") {
      appFlag = val.trim().toLowerCase();
      if (eq === -1) i += 1;
      continue;
    }
    if (flag === "-c" || flag === "--config") {
      configFlag = val.trim();
      if (eq === -1) i += 1;
      continue;
    }
    if (FLY_VALUE_FLAGS.has(flag)) {
      if (eq === -1) i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    subcommands.push(a.toLowerCase());
  }
  return { subcommands, appFlag, configFlag };
}

function decideFlyCommand(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): GuardVerdict {
  const { subcommands, appFlag, configFlag } = parseFlyArgs(args);
  const sub0 = subcommands[0] ?? "";
  const sub1 = subcommands[1] ?? "";
  const isSecretsWrite = sub0 === "secrets" && FLY_SECRET_MUTATIONS.has(sub1);
  const isDeploy = sub0 === "deploy";
  const isWrite = isDeploy || isSecretsWrite || FLY_WRITE_SUBS.has(sub0);
  if (!isWrite) return ALLOW_VERDICT;
  if (isDeploy && !config.cloudCliPolicy.blockDirectFlyDeploy) return ALLOW_VERDICT;
  if (isSecretsWrite && !config.cloudCliPolicy.blockDirectFlySecrets) return ALLOW_VERDICT;

  const repo = inspectRepo(cwd, config);
  const { apps } = loadFleetProtectedApps(repo, config);
  if (apps.length === 0) return ALLOW_VERDICT;

  let targetApp = appFlag;
  const candidateConfig = configFlag
    ? NodePath.resolve(cwd, configFlag)
    : NodePath.join(cwd, "fly.toml");

  if (configFlag || NodeFS.existsSync(candidateConfig)) {
    const parsedToml = readFlyTomlAppName(candidateConfig);
    if (parsedToml.unsafe) {
      return {
        verdict: "deny",
        reason: `host cloud guard: refusing \`fly ${sub0}\` with unsafe config symlink ${candidateConfig}.`,
      };
    }
    if (!targetApp && parsedToml.app) targetApp = parsedToml.app;
  }

  const relConfig =
    repo && configFlag
      ? NodePath.posix.normalize(
          NodePath.relative(safeRealpath(repo.top), safeRealpath(candidateConfig)).replace(
            /\\/g,
            "/",
          ),
        )
      : "";

  const matched = apps.find(
    (app) => app.name === targetApp || (relConfig.length > 0 && app.configPaths.has(relConfig)),
  );
  if (!matched) return ALLOW_VERDICT;

  const allowedDrills = isSecretsWrite ? matched.secretDrills : matched.deployDrills;
  if (hasSanctionedCloudDrillAncestor(repo, allowedDrills, config, procFs)) {
    return ALLOW_VERDICT;
  }

  const drillHint =
    allowedDrills.size > 0
      ? `Use the sanctioned drill: ${Array.from(allowedDrills).toSorted().join(", ")}`
      : "Declare a sanctioned drill in host-guards.json or fleet-shape.json, or request an owner override.";
  return {
    verdict: "deny",
    reason:
      `host cloud guard: refusing direct \`fly ${sub0}${sub1 ? ` ${sub1}` : ""}\` against protected app \`${matched.name}\`.\n` +
      `  ${drillHint}`,
  };
}

function decideDopplerCommand(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): GuardVerdict {
  if (!config.cloudCliPolicy.blockDirectDopplerWrites) return ALLOW_VERDICT;
  const subcommands: string[] = [];
  let project = "";
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "-p" || a === "--project") {
      project = (args[i + 1] ?? "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a.startsWith("--project=")) {
      project = a.slice("--project=".length).trim().toLowerCase();
      continue;
    }
    if (a === "-c" || a === "--config") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    subcommands.push(a.toLowerCase());
  }

  const isSecretsWrite =
    subcommands[0] === "secrets" && DOPPLER_WRITE_SUBS.has(subcommands[1] ?? "");
  if (!isSecretsWrite) return ALLOW_VERDICT;

  const repo = inspectRepo(cwd, config);
  const { apps, dopplerProjects } = loadFleetProtectedApps(repo, config);
  if (dopplerProjects.size > 0 && project && !dopplerProjects.has(project)) {
    return ALLOW_VERDICT;
  }
  if (dopplerProjects.size === 0 && (!repo || !repo.inScope)) {
    return ALLOW_VERDICT;
  }

  const allSecretDrills = new Set<string>();
  for (const app of apps) {
    for (const d of app.secretDrills) allSecretDrills.add(d);
  }
  if (hasSanctionedCloudDrillAncestor(repo, allSecretDrills, config, procFs)) {
    return ALLOW_VERDICT;
  }

  return {
    verdict: "deny",
    reason:
      `host cloud guard: refusing direct \`doppler secrets ${subcommands[1]}\`${project ? ` on project \`${project}\`` : ""}.\n` +
      "  Direct secret mutations must run through a sanctioned secret drill or an owner-approved override.",
  };
}

export function decideCloudCli(
  words: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader = defaultProcFs,
): GuardVerdict {
  if (words.length === 0) return ALLOW_VERDICT;
  const base = NodePath.basename(words[0]!).toLowerCase();
  if (FLY_BINARIES.has(base)) {
    return decideFlyCommand(words.slice(1), cwd, config, procFs);
  }
  if (base === "doppler") {
    return decideDopplerCommand(words.slice(1), cwd, config, procFs);
  }
  return ALLOW_VERDICT;
}
