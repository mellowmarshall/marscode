// @effect-diagnostics nodeBuiltinImport:off - EAS release guard gating OTA and store writes behind default-branch fleet-shape.json drills.
import * as NodePath from "node:path";

import { hasVerifiedDrillAncestor, resolveDefaultBaseRef } from "./drillTrust.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, runHardenedGit, type RepoInfo } from "./repoScope.ts";

export type ReleaseDrillKind = "store" | "ota";

const EAS_READS: ReadonlyArray<string> = [
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
  "version",
  "whoami",
  "config",
  "diagnostics",
  "build:list",
  "build:view",
  "build:version:get",
  "project:info",
  "update:list",
  "update:view",
  "env:list",
  "env:get",
  "channel:list",
  "channel:view",
  "branch:list",
  "branch:view",
  "fingerprint:",
  "account:view",
];

const EAS_OTA_WRITES: ReadonlyArray<string> = ["update", "update:", "env:exec"];

function extractEasSubcommand(args: ReadonlyArray<string>): string | null {
  const firstWord = args.find((a) => !a.startsWith("-")) ?? null;
  if (
    firstWord === null &&
    args.length > 0 &&
    (args[0] === "--version" || args[0] === "-v" || args[0] === "--help" || args[0] === "-h")
  ) {
    return args[0];
  }
  return firstWord;
}

function matchesCommandSet(cmd: string | null, patterns: ReadonlyArray<string>): boolean {
  if (cmd === null) return true;
  return patterns.some((p) => (p.endsWith(":") ? cmd.startsWith(p) : cmd === p));
}

function isEasRead(cmd: string | null): boolean {
  return matchesCommandSet(cmd, EAS_READS);
}

function isEasOtaWrite(cmd: string | null): boolean {
  if (cmd === null) return false;
  return matchesCommandSet(cmd, EAS_OTA_WRITES);
}

function readJsonAtRef(
  repo: RepoInfo,
  ref: string,
  relPath: string,
  config: HostGuardsConfig,
): Record<string, unknown> {
  const raw = runHardenedGit(repo.top, ["show", "--end-of-options", `${ref}:${relPath}`], config);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

function loadDeclaredReleaseDrills(
  repo: RepoInfo,
  config: HostGuardsConfig,
): { readonly store: ReadonlySet<string>; readonly ota: ReadonlySet<string> } {
  const store = new Set<string>();
  const ota = new Set<string>();
  const ref = resolveDefaultBaseRef(repo, config);
  if (!ref) return { store, ota };

  const playbook = readJsonAtRef(repo, ref, "playbook.json", config);
  const fleetBlock = getRecord(playbook, "contracts", "fleet");
  const shapeFile =
    typeof fleetBlock.file === "string" && fleetBlock.file.trim()
      ? fleetBlock.file.trim()
      : "fleet-shape.json";

  const shape = readJsonAtRef(repo, ref, shapeFile, config);
  const apps = getRecord(shape, "apps");
  for (const appVal of Object.values(apps)) {
    const release = getRecord(appVal, "mobile", "release");
    if (typeof release.store === "string" && release.store.trim()) {
      store.add(NodePath.posix.normalize(release.store.trim()));
    }
    if (Array.isArray(release.ota)) {
      for (const item of release.ota) {
        if (typeof item === "string" && item.trim()) {
          ota.add(NodePath.posix.normalize(item.trim()));
        }
      }
    }
  }
  return { store, ota };
}

export function decideReleaseGuard(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader = defaultProcFs,
): GuardVerdict {
  const command = extractEasSubcommand(args);
  if (isEasRead(command)) return ALLOW_VERDICT;

  const kind: ReleaseDrillKind = isEasOtaWrite(command) ? "ota" : "store";
  const repo = inspectRepo(cwd, config);
  const found = repo && repo.inScope ? loadDeclaredReleaseDrills(repo, config) : null;

  if (
    repo &&
    found &&
    hasVerifiedDrillAncestor({
      repo,
      allowedPaths: Array.from(found[kind]),
      requireCleanMerged: true,
      config,
      procFs,
    })
  ) {
    return ALLOW_VERDICT;
  }

  let declaredDetail = "This directory is in no repository that declares a release drill.";
  if (repo && repo.inScope && found) {
    if (found.store.size === 0 && found.ota.size === 0) {
      declaredDetail =
        `${repo.slug} declares no release drill on its default branch: name them in its fleet shape ` +
        "(apps.<app>.mobile.release: store, ota) and merge that first.";
    } else {
      declaredDetail =
        `${repo.slug} declares (run from a clean checkout of its default branch):\n` +
        `  store: ${Array.from(found.store).toSorted().join(" ") || "(none declared)"}\n` +
        `  ota: ${Array.from(found.ota).toSorted().join(" ") || "(none declared)"}`;
    }
  }

  return {
    verdict: "deny",
    reason:
      `host release guard: refusing \`eas ${command}\` outside a declared ${kind} release drill: ` +
      "OTA updates run only under a repo's OTA drill; builds, submissions and every other write only under its store drill.\n" +
      declaredDetail,
  };
}
