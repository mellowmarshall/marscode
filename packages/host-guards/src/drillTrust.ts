// @effect-diagnostics nodeBuiltinImport:off - Shared verified drill-ancestor checker for releaseGuard, cloudCliGuard, and treeGuard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { safeRealpath, TEST_TMP_PREFIXES, type HostGuardsConfig } from "./hostConfig.ts";
import {
  defaultProcFs,
  isUnsafeEnvEntry,
  listAncestorsWithComm,
  readProcArgv,
  type ProcFsReader,
} from "./procFs.ts";
import { runHardenedGit, runHardenedGitBuffer, type RepoInfo } from "./repoScope.ts";

const DRILL_EXTRA_UNSAFE_ENV_KEYS: Readonly<Record<"node" | "bash" | "sh", ReadonlySet<string>>> = {
  node: new Set(["LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS"]),
  bash: new Set(["LD_LIBRARY_PATH", "BASH_ENV", "SHELLOPTS", "BASHOPTS"]),
  sh: new Set(["LD_LIBRARY_PATH", "BASH_ENV", "SHELLOPTS", "BASHOPTS"]),
};

const DRILL_EXTRA_UNSAFE_ENV_PREFIXES: Readonly<
  Record<"node" | "bash" | "sh", ReadonlyArray<string>>
> = {
  node: [],
  bash: ["BASH_FUNC_"],
  sh: ["BASH_FUNC_"],
};

const NODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts"]);
const UNSAFE_PATH_PREFIXES = [...TEST_TMP_PREFIXES, "/dev/shm/"];

const TRUSTED_SYSTEM_INTERPRETERS: Readonly<Record<string, "bash" | "sh" | "node">> = {
  "/usr/bin/bash": "bash",
  "/bin/bash": "bash",
  "/usr/local/bin/bash": "bash",
  "/usr/bin/sh": "sh",
  "/bin/sh": "sh",
  "/usr/bin/dash": "sh",
  "/bin/dash": "sh",
  "/usr/bin/node": "node",
  "/bin/node": "node",
  "/usr/local/bin/node": "node",
};

const TRUSTED_SYSTEM_PATH_DIRS = new Set([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/snap/bin",
  "/usr/games",
  "/usr/local/games",
]);

function isUnderPrefix(target: string, prefix: string): boolean {
  const normTarget = NodePath.posix.normalize(target);
  const normPrefix = NodePath.posix.normalize(prefix).replace(/\/+$/, "");
  return normTarget === normPrefix || normTarget.startsWith(`${normPrefix}/`);
}

function isNonGroupWorldWritable(mode: number): boolean {
  return (mode & 0o022) === 0;
}

function resolveTrustedInterpreter(
  rawExe: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): "bash" | "sh" | "node" | null {
  if (!rawExe || rawExe.endsWith(" (deleted)")) return null;
  const realExe = procFs.realpath(rawExe);
  const systemKind = TRUSTED_SYSTEM_INTERPRETERS[realExe];
  if (systemKind) {
    const st = procFs.stat(realExe);
    if (!st || !st.isFile || st.uid !== 0 || !isNonGroupWorldWritable(st.mode)) {
      return null;
    }
    return systemKind;
  }
  if (config.realNode) {
    const configuredRealNode = procFs.realpath(config.realNode);
    if (realExe === configuredRealNode) {
      const st = procFs.stat(realExe);
      const curUid = procFs.currentUid();
      if (
        !st ||
        !st.isFile ||
        (st.uid !== 0 && st.uid !== curUid) ||
        !isNonGroupWorldWritable(st.mode)
      ) {
        return null;
      }
      return "node";
    }
  }
  return null;
}

function isUnsafePathValue(
  pathValue: string,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): boolean {
  if (!pathValue) return true;
  const trustedConfigured = new Set<string>();
  const realSourceRoot = procFs.realpath(config.sourceRoot);
  const realDataRoot = procFs.realpath(config.dataRoot);
  for (const dir of config.trustedPathDirs) {
    const resolved = procFs.realpath(dir);
    const withSlash = resolved.endsWith("/") ? resolved : `${resolved}/`;
    if (UNSAFE_PATH_PREFIXES.some((prefix) => withSlash.startsWith(prefix))) continue;
    if (isUnderPrefix(resolved, realSourceRoot) || isUnderPrefix(resolved, realDataRoot)) continue;
    trustedConfigured.add(resolved);
  }

  const segments = pathValue.split(":");
  for (const seg of segments) {
    // Reject empty segment (`::`, leading/trailing `:`), `.`, or any relative segment.
    if (!seg || seg === "." || !seg.startsWith("/") || seg.includes("..")) return true;
    const realSeg = procFs.realpath(seg);
    const withSlash = realSeg.endsWith("/") ? realSeg : `${realSeg}/`;
    if (UNSAFE_PATH_PREFIXES.some((prefix) => withSlash.startsWith(prefix))) {
      return true;
    }
    if (TRUSTED_SYSTEM_PATH_DIRS.has(realSeg)) {
      const st = procFs.stat(realSeg);
      if (st !== null && (st.uid !== 0 || !isNonGroupWorldWritable(st.mode))) {
        return true;
      }
      continue;
    }
    if (trustedConfigured.has(realSeg)) {
      const st = procFs.stat(realSeg);
      const curUid = procFs.currentUid();
      if (!st || (st.uid !== 0 && st.uid !== curUid) || !isNonGroupWorldWritable(st.mode)) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

function hasUnsafeDrillEnv(
  pid: number,
  exe: "bash" | "sh" | "node",
  config: HostGuardsConfig,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const raw = procFs.readText(`/proc/${pid}/environ`);
  if (raw === null) return true;
  const extraKeys = DRILL_EXTRA_UNSAFE_ENV_KEYS[exe];
  const extraPrefixes = DRILL_EXTRA_UNSAFE_ENV_PREFIXES[exe];

  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("PATH=")) {
      if (isUnsafePathValue(entry.slice("PATH=".length), config, procFs)) return true;
      continue;
    }
    if (isUnsafeEnvEntry(entry, extraKeys, extraPrefixes)) {
      return true;
    }
  }
  return false;
}

function allowedInterpretersForScript(scriptPath: string): ReadonlyArray<"bash" | "sh" | "node"> {
  const ext = NodePath.extname(scriptPath).toLowerCase();
  if (ext === ".sh") return ["bash", "sh"];
  if (NODE_EXTS.has(ext)) return ["node"];
  return [];
}

function matchesAllowedDrillRule(relPath: string, allowedRules: ReadonlyArray<string>): boolean {
  const norm = NodePath.posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\.\//, "");
  for (const raw of allowedRules) {
    const rule = raw.replace(/^\.\//, "");
    if (rule.endsWith("/")) {
      if (norm.startsWith(rule)) return true;
    } else if (norm === NodePath.posix.normalize(rule)) {
      return true;
    }
  }
  return false;
}

function isCleanMergedCheckout(repo: RepoInfo, baseRef: string, config: HostGuardsConfig): boolean {
  const status = runHardenedGit(repo.top, ["status", "--porcelain"], config);
  if (status !== "") return false;
  const head = runHardenedGit(repo.top, ["rev-parse", "HEAD"], config)?.trim();
  if (!head) return false;
  return runHardenedGit(repo.top, ["merge-base", "--is-ancestor", head, baseRef], config) !== null;
}

export function resolveDefaultBaseRef(repo: RepoInfo, config: HostGuardsConfig): string | null {
  for (const base of repo.bases()) {
    const ref = `refs/remotes/origin/${base}`;
    if (
      runHardenedGit(repo.top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], config) !== null
    ) {
      return ref;
    }
  }
  return null;
}

export interface VerifiedDrillCheckInput {
  readonly repo: RepoInfo;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly requireCleanMerged: boolean;
  readonly config: HostGuardsConfig;
  readonly procFs?: ProcFsReader | undefined;
  readonly startPid?: number | undefined;
}

/**
 * Verifies an ancestor is executing an exact allowed drill script via its expected interpreter
 * (`bash`/`sh` for `.sh`, `node` for `.js`/`.mjs`/`.ts`), with no interpreter flags, clean env,
 * safe PATH, and (when required) clean merged checkout whose on-disk bytes match default-branch blob.
 */
export function hasVerifiedDrillAncestor(input: VerifiedDrillCheckInput): boolean {
  if (!input.repo.inScope || input.allowedPaths.length === 0) return false;
  const procFs = input.procFs ?? defaultProcFs;
  const baseRef = resolveDefaultBaseRef(input.repo, input.config);
  if (input.requireCleanMerged) {
    if (!baseRef || !isCleanMergedCheckout(input.repo, baseRef, input.config)) return false;
  }

  const topReal = safeRealpath(input.repo.top);
  for (const { pid } of listAncestorsWithComm(input.startPid, procFs)) {
    const rawExe = procFs.readLink(`/proc/${pid}/exe`) ?? "";
    const exe = resolveTrustedInterpreter(rawExe, input.config, procFs);
    if (!exe) continue;

    const words = readProcArgv(pid, procFs);
    if (words.length < 2 || words[1]!.startsWith("-")) continue;

    const allowedInterpreters = allowedInterpretersForScript(words[1]!);
    if (!allowedInterpreters.includes(exe)) continue;
    if (hasUnsafeDrillEnv(pid, exe, input.config, procFs)) continue;

    const procCwd = procFs.readLink(`/proc/${pid}/cwd`) ?? "/";
    const candidate = NodePath.resolve(procCwd, words[1]!);
    try {
      if (!NodeFS.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }

    const fileReal = safeRealpath(candidate);
    if (!fileReal.startsWith(`${topReal}/`)) continue;
    const rel = NodePath.posix.normalize(NodePath.relative(topReal, fileReal).replace(/\\/g, "/"));
    if (!matchesAllowedDrillRule(rel, input.allowedPaths)) continue;

    if (baseRef) {
      const committed = runHardenedGitBuffer(
        input.repo.top,
        ["show", "--end-of-options", `${baseRef}:${rel}`],
        input.config,
      );
      if (!committed) continue;
      try {
        if (!committed.equals(NodeFS.readFileSync(fileReal))) continue;
      } catch {
        continue;
      }
    } else if (input.requireCleanMerged) {
      continue;
    }
    return true;
  }
  return false;
}
