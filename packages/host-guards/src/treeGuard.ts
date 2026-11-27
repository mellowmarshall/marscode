// @effect-diagnostics nodeBuiltinImport:off - Tree freshness, clean working tree, and shared-DB CI turn guard.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { hasVerifiedDrillAncestor } from "./drillTrust.ts";
import { canonicalHomeDir, safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import { defaultProcFs, listAncestorsWithComm, readProcStat, type ProcFsReader } from "./procFs.ts";
import { isQueueDaemonInAncestry, isTrustedShipQueueProcess } from "./t3ServerTrust.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, runHardenedGit, type RepoInfo } from "./repoScope.ts";
import { unwrapCommand } from "./shellTokenize.ts";

export type TreeGuardKind = "test" | "gate" | "auto" | "push";

const DEFAULT_GATES: ReadonlyArray<string> = ["ci-local.sh", "scripts/gates/"];
const DEFAULT_SANCTIONED: ReadonlyArray<string> = ["scripts/drills/"];
const DEFAULT_TEST_SCRIPTS: ReadonlyArray<string> = ["test", "test:*", "*:test"];
const DEFAULT_GATE_SCRIPTS: ReadonlyArray<string> = ["verify", "verify:*"];
const TEST_RUNNER_PROGS = new Set(["pytest", "vitest", "playwright", "jest"]);

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesPathRule(relPath: string, patterns: ReadonlyArray<string>): boolean {
  if (!relPath || relPath.startsWith("..")) return false;
  const norm = relPath.replace(/^\.\//, "").replace(/\\/g, "/");
  for (const raw of patterns) {
    const pat = raw.replace(/^\.\//, "");
    if (pat.endsWith("/")) {
      if (norm.startsWith(pat)) return true;
    } else if (norm === pat) {
      return true;
    }
  }
  return false;
}

function relativeToRepo(arg: string, cwd: string, repoTop: string): string {
  if (!arg || arg.startsWith("-")) return "";
  const resolved = safeRealpath(NodePath.resolve(cwd, arg));
  const topReal = safeRealpath(repoTop);
  if (!resolved.startsWith(`${topReal}/`)) return "";
  return NodePath.relative(topReal, resolved).replace(/\\/g, "/");
}

function pushRunsPrePushHook(
  repo: RepoInfo,
  args: ReadonlyArray<string>,
  config: HostGuardsConfig,
): boolean {
  const hookPath = runHardenedGit(
    repo.top,
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"],
    config,
  )?.trim();
  if (!hookPath) return false;
  try {
    const st = NodeFS.statSync(hookPath);
    if (!st.isFile() || (st.mode & 0o111) === 0) return false;
  } catch {
    return false;
  }
  let seenPush = false;
  let skipNext = false;
  let pos = 0;
  let isDelete = false;
  let refs = 0;
  let hasUpdate = false;
  const valueFlags = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

  for (const a of args) {
    if (!seenPush) {
      if (a === "push") seenPush = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a === "--delete" || a === "-d") {
      isDelete = true;
    } else if (valueFlags.has(a)) {
      skipNext = true;
    } else if (!a.startsWith("-")) {
      pos += 1;
      if (pos > 1) {
        refs += 1;
        if (!a.startsWith(":")) hasUpdate = true;
      }
    }
  }
  if (isDelete) return false;
  return refs === 0 || hasUpdate;
}

function hasActiveShipQueueWorkerAncestor(
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
  procFs: ProcFsReader,
): boolean {
  const jobId = env.SHIP_QUEUE_JOB?.trim();
  if (!jobId) return false;
  const workerMetaPath = NodePath.join(config.queueRoot, "jobs", jobId, "worker.pid");
  const raw = procFs.readText(workerMetaPath);
  if (!raw) return false;
  const parts = raw.trim().split(/\s+/);
  const workerPid = Number.parseInt(parts[0] ?? "", 10);
  const expectedStart = parts[1] ?? "";
  if (!Number.isInteger(workerPid) || workerPid <= 1) return false;
  if (!isTrustedShipQueueProcess(workerPid, config.queueRoot, procFs)) return false;
  const ancestors = listAncestorsWithComm(undefined, procFs);
  if (!ancestors.some((a) => a.pid === workerPid)) return false;
  if (expectedStart) {
    const stat = readProcStat(workerPid, procFs);
    if (stat.starttime && stat.starttime !== expectedStart) return false;
  }
  return true;
}

function hasSanctionedDrillAncestor(
  repo: RepoInfo,
  sanctionedPaths: ReadonlyArray<string>,
  config: HostGuardsConfig,
  procFs: ProcFsReader,
): boolean {
  return hasVerifiedDrillAncestor({
    repo,
    allowedPaths: sanctionedPaths,
    requireCleanMerged: false,
    config,
    procFs,
  });
}

function matchesSharedDbRun(
  kind: TreeGuardKind,
  script: string,
  runArgs: ReadonlyArray<string>,
  cwd: string,
  repoTop: string,
  patterns: ReadonlyArray<string>,
): boolean {
  for (const pat of patterns) {
    if (pat === "pre-push" && kind === "push") return true;
    if (pat.startsWith("script:") && script && globMatch(script, pat.slice("script:".length))) {
      return true;
    }
    if (!pat.startsWith("script:") && pat !== "pre-push") {
      for (const arg of runArgs) {
        if (matchesPathRule(relativeToRepo(arg, cwd, repoTop), [pat])) return true;
      }
    }
  }
  return false;
}

function checkCiTurnContention(
  repo: RepoInfo,
  kind: TreeGuardKind,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
  procFs: ProcFsReader,
  loadavgPath?: string,
): GuardVerdict {
  const loadSrc = loadavgPath || "/proc/loadavg";
  const loadRaw = procFs.readText(loadSrc);
  if (loadRaw) {
    const load1 = Number.parseFloat(loadRaw.trim().split(/\s+/)[0] ?? "");
    if (Number.isFinite(load1) && load1 >= 8) {
      return {
        verdict: "deny",
        reason:
          `tree-guard: refusing this ${kind} run: the host is busy (load1=${Math.floor(load1)}, limit is below 8).\n` +
          `  tree: ${repo.top} (${repo.headBranch ?? "DETACHED"})\n` +
          "  Wait for host load to settle or submit to the ship queue.",
      };
    }
  }

  const homeDir = canonicalHomeDir();
  const candidates = [
    NodePath.join(homeDir, ".local", "bin", "ship-queue"),
    "/usr/local/bin/ship-queue",
    "/usr/bin/ship-queue",
  ];
  for (const bin of candidates) {
    try {
      const st = NodeFS.statSync(bin);
      if (!st.isFile() || (st.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    const res = NodeChildProcess.spawnSync(bin, ["ci-busy"], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: homeDir,
        TREE_GUARD_RUN_PID: String(procFs.selfPid()),
        TREE_GUARD_RUN_REPO: repo.slug,
        SHIP_QUEUE_ROOT: config.queueRoot,
      },
    });
    if (res.error) continue;
    if (res.status === 0) {
      const holder = (res.stdout ?? "").trim() || "unknown";
      return {
        verdict: "deny",
        reason:
          `tree-guard: refusing this ${kind} run: the CI turn of ${repo.slug} is held by ${holder}.\n` +
          `  tree: ${repo.top} (${repo.headBranch ?? "DETACHED"})\n` +
          "  Run it again when that run ends (who holds it: ship-queue ci-status).",
      };
    }
    break;
  }
  return ALLOW_VERDICT;
}

export interface TreeGuardInput {
  readonly kind?: TreeGuardKind | undefined;
  readonly script?: string | undefined;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly cwd: string;
  /** Programmatic loadavg file override for unit tests only. */
  readonly loadavgPath?: string | undefined;
}

export function decideTreeGuard(
  input: TreeGuardInput,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv = process.env,
  procFs: ProcFsReader = defaultProcFs,
): GuardVerdict {
  if (!NodeFS.existsSync(input.cwd)) return ALLOW_VERDICT;
  const repo = inspectRepo(input.cwd, config, env);
  if (!repo || !repo.inScope) return ALLOW_VERDICT;

  const args = input.args ?? [];
  const script = input.script?.trim() ?? "";
  let kind: TreeGuardKind | null = input.kind ?? null;

  if (kind === "push" && !pushRunsPrePushHook(repo, args, config)) {
    return ALLOW_VERDICT;
  }

  const gates = [...DEFAULT_GATES, ...repo.declaredValues("gate")];
  const sanctioned = [...DEFAULT_SANCTIONED, ...repo.declaredValues("sanctioned")];
  const testScripts = [...DEFAULT_TEST_SCRIPTS, ...repo.declaredValues("test_script")];
  const gateScripts = [...DEFAULT_GATE_SCRIPTS, ...repo.declaredValues("gate_script")];
  const sharedDbPatterns = repo.declaredValues("shared_db_run");

  if (script) {
    if (gateScripts.some((p) => globMatch(script, p))) kind = "gate";
    else if (testScripts.some((p) => globMatch(script, p))) kind = "test";
    else return ALLOW_VERDICT;
  }
  if (!kind) return ALLOW_VERDICT;

  if (kind === "auto") {
    const unwrapped = unwrapCommand(args).command;
    const prog = unwrapped[0] ?? "";
    const progBase = NodePath.basename(prog);
    if (prog && matchesPathRule(relativeToRepo(prog, input.cwd, repo.top), gates)) {
      kind = "gate";
    } else if (
      TEST_RUNNER_PROGS.has(progBase) ||
      ((progBase === "go" || progBase === "cargo") && unwrapped.includes("test"))
    ) {
      kind = "test";
    } else {
      return ALLOW_VERDICT;
    }
  } else if (kind === "test") {
    if (args.some((arg) => matchesPathRule(relativeToRepo(arg, input.cwd, repo.top), gates))) {
      kind = "gate";
    }
  }

  // Queue daemon, live queue worker, or sanctioned ancestor drill pass untouched.
  if (
    isQueueDaemonInAncestry(config.queueRoot, undefined, procFs) ||
    hasActiveShipQueueWorkerAncestor(config, env, procFs) ||
    hasSanctionedDrillAncestor(repo, sanctioned, config, procFs)
  ) {
    return ALLOW_VERDICT;
  }

  const declaredBase = repo.declaredValues("base_ref")[0];
  const baseRef = declaredBase || (repo.originHead ? `origin/${repo.originHead}` : "");
  const trunk = repo.declaredValues("trunk_branch")[0] || repo.originHead || "main";
  const branch = repo.headBranch ?? "DETACHED";

  const realSourceRoot = safeRealpath(config.sourceRoot);
  const realTop = safeRealpath(repo.top);
  const isPrimary = realTop === safeRealpath(repo.primary);
  if (
    isPrimary &&
    (realTop === realSourceRoot || realTop.startsWith(`${realSourceRoot}/`)) &&
    safeRealpath(config.sourceRoot) !== safeRealpath(config.dataRoot)
  ) {
    const repoName = repo.slug.includes("/")
      ? repo.slug.split("/", 2)[1]!
      : NodePath.basename(repo.primary);
    return {
      verdict: "deny",
      reason:
        `tree-guard: refusing this ${kind} run: refusing run in primary checkout ${repo.top}.\n` +
        `  tree: ${repo.top} (${branch})\n` +
        `  The primary checkout must stay clean on ${trunk}.\n` +
        `  Work in a worktree under ${config.dataRoot}/${repoName}/<name>.`,
    };
  }

  if (!baseRef) {
    return {
      verdict: "deny",
      reason:
        `tree-guard: refusing this ${kind} run: origin/HEAD is not set, so this repo's default branch (the base) is unknown.\n` +
        `  tree: ${repo.top} (${branch})\n` +
        "  Fix: git remote set-head origin -a, then run again.",
    };
  }

  const fullRemoteRef = baseRef.startsWith("refs/") ? baseRef : `refs/remotes/${baseRef}`;
  const fix = `git fetch && git rebase ${baseRef}`;
  if (
    runHardenedGit(
      repo.top,
      ["rev-parse", "-q", "--verify", `${fullRemoteRef}^{commit}`],
      config,
      env,
    ) === null
  ) {
    return {
      verdict: "deny",
      reason:
        `tree-guard: refusing this ${kind} run: ${baseRef} does not resolve in this checkout.\n` +
        `  tree: ${repo.top} (${branch})\n` +
        `  Fix: git fetch ${baseRef.split("/")[0] ?? "origin"}, then run again (${fix}).`,
    };
  }

  if (
    runHardenedGit(
      repo.top,
      ["merge-base", "--is-ancestor", fullRemoteRef, "HEAD"],
      config,
      env,
    ) === null
  ) {
    return {
      verdict: "deny",
      reason:
        `tree-guard: refusing this ${kind} run: HEAD does not contain ${baseRef} (the tree is not rebased).\n` +
        `  tree: ${repo.top} (${branch})\n` +
        `  Fix: ${fix}`,
    };
  }

  const isPrimaryTrunk = isPrimary && branch === trunk;
  if ((kind === "gate" || kind === "push") && !isPrimaryTrunk) {
    const dirtyOut = runHardenedGit(repo.top, ["status", "--porcelain"], config, env) ?? "";
    const dirtyLines = dirtyOut
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .slice(0, 5);
    if (dirtyLines.length > 0) {
      return {
        verdict: "deny",
        reason:
          `tree-guard: refusing this ${kind} run: the tree has uncommitted or untracked files:\n` +
          dirtyLines.map((l) => `  ${l}`).join("\n") +
          `\n  tree: ${repo.top} (${branch})\n` +
          `  Fix: commit them (never stash), then: ${fix}`,
      };
    }
  }

  if (matchesSharedDbRun(kind, script, args, input.cwd, repo.top, sharedDbPatterns)) {
    return checkCiTurnContention(repo, kind, config, env, procFs, input.loadavgPath);
  }
  return ALLOW_VERDICT;
}
