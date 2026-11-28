// @effect-diagnostics nodeBuiltinImport:off - Git guard enforcing hooks integrity, no-verify, SKIP_CI, primary checkout protection, stash, and push safety.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";

import {
  hasNoVerifyFlag,
  isBranchCreation,
  isCheckoutBranchOp,
  splitGitGlobals,
  splitSimpleAliasArgs,
} from "./gitArgParse.ts";
import { checkGitConfigWrite } from "./gitConfigGuard.ts";
import { safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import {
  defaultProcFs,
  listAncestorsWithComm,
  readProcEnvVar,
  type ProcFsReader,
} from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import { resolveT3ServerPid } from "./t3ServerTrust.ts";
import { ALLOW_VERDICT, decidePush, type GuardVerdict } from "./pushGuard.ts";
import {
  formatMergeRefusal,
  inspectRepo,
  isUrlInScope,
  runHardenedGit,
  type RepoInfo,
} from "./repoScope.ts";

const SKIP_CI_SUBS = new Set(["commit", "push", "merge"]);
const STASH_READS = new Set(["list", "show", "create"]);
const COMMIT_CREATING_SUBS = new Set(["commit", "merge", "cherry-pick", "revert", "am"]);
const CONFIG_OVERRIDE_ENV = new Set([
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);
const BUILTINS = new Set([
  "add",
  "am",
  "apply",
  "blame",
  "branch",
  "cat-file",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "config",
  "describe",
  "diff",
  "fetch",
  "for-each-ref",
  "grep",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge",
  "merge-base",
  "mv",
  "pull",
  "push",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "rm",
  "send-pack",
  "show",
  "show-ref",
  "stash",
  "status",
  "switch",
  "symbolic-ref",
  "tag",
  "worktree",
]);

function buildHooksCheckEnv(env: NodeJS.ProcessEnv, clean: boolean): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  if (clean) {
    for (const key of Object.keys(out)) {
      if (key.startsWith("GIT_CONFIG") || CONFIG_OVERRIDE_ENV.has(key)) {
        delete out[key];
      }
    }
  }
  return out;
}

function effectiveHooksDir(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  clean: boolean,
): string {
  const argv: string[] = ["-C", cwd];
  if (!clean) {
    for (const pair of configs) argv.push("-c", pair);
  }
  argv.push("rev-parse", "--path-format=absolute", "--git-path", "hooks");
  const res = NodeChildProcess.spawnSync(config.realGit, argv, {
    encoding: "utf8",
    timeout: 10_000,
    env: buildHooksCheckEnv(env, clean),
  });
  if (res.status !== 0) return "?";
  return safeRealpath((res.stdout ?? "").trim());
}

function isT3ServerWorktreeBranchOp(
  sub: ReadonlyArray<string>,
  repo: RepoInfo,
  runEnv: NodeJS.ProcessEnv,
  procFs: ProcFsReader,
): boolean {
  let branch = "";
  if (sub.length === 5 && sub[0] === "branch" && sub[1] === "--no-track" && sub[2] === "--") {
    branch = sub[3] ?? "";
  } else if (
    sub.length === 4 &&
    sub[0] === "branch" &&
    (sub[1] ?? "").startsWith("--set-upstream-to=refs/remotes/") &&
    sub[2] === "--"
  ) {
    branch = sub[3] ?? "";
  }
  if (
    !branch ||
    branch.startsWith("-") ||
    repo.bases().includes(branch) ||
    branch === repo.headBranch
  ) {
    return false;
  }
  if (resolveCallerIdentity({ env: runEnv, procFs }).isAgent) return false;
  const serverPid = resolveT3ServerPid({ procFs });
  if (serverPid === null) return false;
  for (const { pid } of listAncestorsWithComm(undefined, procFs)) {
    if (pid === serverPid) return true;
    if (readProcEnvVar(pid, AGENT_THREAD_ENV, procFs)) return false;
  }
  return false;
}

function lookupGitAlias(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  name: string,
): string | null {
  if (BUILTINS.has(name)) return null;
  const argv: string[] = ["-C", cwd];
  for (const pair of configs) argv.push("-c", pair);
  const res = NodeChildProcess.spawnSync(
    config.realGit,
    [...argv, "config", "--get", `alias.${name}`],
    { encoding: "utf8", timeout: 10_000, env: buildHooksCheckEnv(env, false) },
  );
  if (res.status !== 0) return null;
  const value = (res.stdout ?? "").trim();
  return value || null;
}

const MAX_GIT_ALIAS_DEPTH = 8;

export function decideGit(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  initialCwd: string,
  config: HostGuardsConfig,
  options?: {
    readonly depth?: number | undefined;
    readonly seenAliases?: ReadonlySet<string> | undefined;
    readonly procFs?: ProcFsReader | undefined;
  },
): GuardVerdict {
  const depth = options?.depth ?? 0;
  const seenAliases = options?.seenAliases ?? new Set<string>();
  const procFs = options?.procFs ?? defaultProcFs;
  const { configs, cwd, sub, extraEnv } = splitGitGlobals(args, initialCwd, env);
  if (sub.length === 0) return ALLOW_VERDICT;

  const runEnv: NodeJS.ProcessEnv = { ...env, ...extraEnv };
  const name = sub[0]!;
  const repo = inspectRepo(cwd, config, runEnv);
  const inScope = repo !== null && repo.inScope;

  const alias = lookupGitAlias(cwd, configs, runEnv, config, name);
  if (alias !== null) {
    const aliasKey = name.toLowerCase();
    if (alias.startsWith("!")) {
      const cleaned = [alias, ...sub.slice(1)].join(" ").replace(/[\\'"]/g, "");
      if (inScope || /\bpush\b|send-pack|http-push/.test(cleaned)) {
        return {
          verdict: "deny",
          reason: `host git guard: refusing the shell alias \`git ${name}\`: it runs git outside the guard.`,
        };
      }
      return ALLOW_VERDICT;
    }
    if (seenAliases.has(aliasKey) || depth >= MAX_GIT_ALIAS_DEPTH) {
      return {
        verdict: "deny",
        reason: `host git guard: refusing git alias \`${name}\`: alias expansion ${seenAliases.has(aliasKey) ? "detected a cycle" : `exceeded max depth (${MAX_GIT_ALIAS_DEPTH})`}.`,
      };
    }
    const nextSeen = new Set(seenAliases);
    nextSeen.add(aliasKey);
    const expanded: string[] = [];
    for (const pair of configs) expanded.push("-c", pair);
    expanded.push(...splitSimpleAliasArgs(alias), ...sub.slice(1));
    return decideGit(expanded, runEnv, cwd, config, {
      depth: depth + 1,
      seenAliases: nextSeen,
      procFs,
    });
  }

  if (name === "push" && !inScope) {
    return decidePush(sub.slice(1), cwd, runEnv, configs, config);
  }
  if (
    (name === "send-pack" || name === "http-push") &&
    (inScope || sub.slice(1).some((a) => isUrlInScope(a, config)))
  ) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(
        `git ${name} (a push without the push guard)`,
        inScope ? repo : null,
        config,
      ),
    };
  }
  if (!inScope || repo === null) return ALLOW_VERDICT;

  const realSourceRoot = safeRealpath(config.sourceRoot);
  const realTop = safeRealpath(repo.top);
  const isPrimary =
    realTop === safeRealpath(repo.primary) &&
    (realTop === realSourceRoot || realTop.startsWith(`${realSourceRoot}/`));
  const repoName =
    repo.slug !== "?" ? repo.slug.split("/").pop()! : NodePath.basename(repo.primary);
  const trunk = repo.originHead || repo.bases()[0] || "main";

  if (COMMIT_CREATING_SUBS.has(name)) {
    if (repo.headBranch && repo.bases().includes(repo.headBranch)) {
      return {
        verdict: "deny",
        reason:
          `host git guard: refusing ${name} directly on ${repo.headBranch} in ${repo.slug}.\n` +
          `  All changes must be developed in a worktree under ${config.dataRoot}/${repoName}/<name> on a feature branch.`,
      };
    }
    if (isPrimary) {
      return {
        verdict: "deny",
        reason:
          `host git guard: refusing ${name} in primary checkout ${repo.primary}.\n` +
          `  The primary checkout must stay on ${trunk}. Create a worktree instead:\n` +
          `  git worktree add ${config.dataRoot}/${repoName}/<name> -b <branch>`,
      };
    }
  }

  if (
    isPrimary &&
    (name === "switch" || (name === "checkout" && isCheckoutBranchOp(sub, cwd, runEnv, config)))
  ) {
    const nonQuiet = sub.slice(1).filter((a) => a !== "-q" && a !== "--quiet");
    if (nonQuiet.length === 1 && nonQuiet[0] === trunk) {
      const local = runHardenedGit(
        cwd,
        ["rev-parse", "--verify", "-q", `refs/heads/${trunk}`],
        config,
        runEnv,
      );
      if (
        local === null ||
        runHardenedGit(
          cwd,
          ["merge-base", "--is-ancestor", local.trim(), `refs/remotes/origin/${trunk}`],
          config,
          runEnv,
        ) !== null
      ) {
        return ALLOW_VERDICT;
      }
    }
    return {
      verdict: "deny",
      reason:
        `host git guard: refusing branch operations in primary checkout ${repo.primary}.\n` +
        `  The primary checkout must stay on ${trunk}. Create a worktree instead:\n` +
        `  git worktree add ${config.dataRoot}/${repoName}/<name> -b <branch>`,
    };
  }

  if (
    isPrimary &&
    name === "branch" &&
    isBranchCreation(sub) &&
    !isT3ServerWorktreeBranchOp(sub, repo, runEnv, procFs)
  ) {
    return {
      verdict: "deny",
      reason:
        `host git guard: refusing branch creation in primary checkout ${repo.primary}.\n` +
        `  The primary checkout must stay on ${trunk}. Create a worktree instead:\n` +
        `  git worktree add ${config.dataRoot}/${repoName}/<name> -b <branch>`,
    };
  }

  if (name === "subtree" && sub[1] === "push") {
    return {
      verdict: "deny",
      reason: formatMergeRefusal("git subtree push (a push without the push guard)", repo, config),
    };
  }

  const overridden =
    configs.length > 0 ||
    Object.keys(runEnv).some((k) => k.startsWith("GIT_CONFIG") || CONFIG_OVERRIDE_ENV.has(k));
  if (
    overridden &&
    effectiveHooksDir(cwd, configs, runEnv, config, false) !==
      effectiveHooksDir(cwd, configs, runEnv, config, true)
  ) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing a git ${name} whose hooks directory is overridden: it skips ${repo.slug}'s hooks.`,
    };
  }

  if (name === "config") {
    const cfgVerdict = checkGitConfigWrite(repo, sub, config);
    if (cfgVerdict.verdict === "deny") return cfgVerdict;
  }

  if (hasNoVerifyFlag(sub)) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing git ${name} --no-verify in ${repo.slug}: the hooks are the gate.`,
    };
  }

  if (SKIP_CI_SUBS.has(name) && env.SKIP_CI) {
    return {
      verdict: "deny",
      reason: `host git guard: refusing git ${name} with SKIP_CI set in ${repo.slug}: it skips the gate.`,
    };
  }

  if (name === "stash") {
    const action = sub.slice(1).find((a) => !a.startsWith("-")) ?? "push";
    const count = repo.worktreeCount();
    if (!STASH_READS.has(action) && count > 1) {
      return {
        verdict: "deny",
        reason:
          `host git guard: refusing git stash ${action} in ${repo.slug}: its ${count} worktrees share one stash stack, ` +
          "so a stash here is another lane's pop. Commit to your own branch instead (a WIP commit is fine).",
      };
    }
  }

  if (name === "push") {
    return decidePush(sub.slice(1), cwd, runEnv, configs, config);
  }
  return ALLOW_VERDICT;
}
