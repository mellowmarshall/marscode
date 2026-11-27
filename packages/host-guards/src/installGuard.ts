// @effect-diagnostics nodeBuiltinImport:off - Storage hygiene guard blocking dependency installs and git worktree add inside sourceRoot checkouts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo } from "./repoScope.ts";
import { simpleCommands } from "./shellScan.ts";
import { unwrapCommand } from "./shellTokenize.ts";

const NODE_INSTALL_SUBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["install", "i", "ci", "add"]),
  pnpm: new Set(["install", "i", "ci", "add"]),
  yarn: new Set(["install", "add"]),
  bun: new Set(["install", "i", "add"]),
  vp: new Set(["install", "i", "add"]),
};

const GLOBAL_FLAGS = new Set(["-g", "--global"]);
const PREFIX_FLAGS = new Set(["--prefix", "--dir", "-C"]);

const PM_DIR_FLAGS = new Set(["--dir", "-C", "--prefix"]);
const PM_VALUE_FLAGS = new Set([
  "--dir",
  "-C",
  "--prefix",
  "--filter",
  "-F",
  "--reporter",
  "--loglevel",
  "--workspace-concurrency",
]);
const NPM_VALUE_FLAGS = new Set([...PM_VALUE_FLAGS, "--workspace", "-w"]);
const PM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "update",
  "up",
  "exec",
  "x",
  "dlx",
  "why",
  "list",
  "ls",
  "outdated",
  "audit",
  "store",
  "config",
  "link",
  "unlink",
  "prune",
  "publish",
  "pack",
  "import",
  "rebuild",
  "root",
  "bin",
  "env",
  "setup",
  "create",
  "init",
  "patch",
  "patch-commit",
  "fetch",
  "deploy",
  "licenses",
  "server",
  "doctor",
  "help",
  "ci",
  "cache",
  "view",
  "version",
]);

function isUnderPath(candidate: string, root: string): boolean {
  const realCand = safeRealpath(candidate);
  const realRoot = safeRealpath(root);
  return realCand === realRoot || realCand.startsWith(`${realRoot}/`);
}

function repoNameAt(dirPath: string, config: HostGuardsConfig): string | null {
  try {
    if (!NodeFS.statSync(dirPath).isDirectory()) return null;
  } catch {
    return null;
  }
  const repo = inspectRepo(dirPath, config);
  if (!repo || !repo.inScope) return null;
  return repo.slug.includes("/") ? repo.slug.split("/", 2)[1]! : NodePath.basename(repo.primary);
}

function extractPrefixTargets(tokens: ReadonlyArray<string>, cwd: string): ReadonlyArray<string> {
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (PREFIX_FLAGS.has(name) && eq !== -1) {
      targets.push(safeRealpath(NodePath.resolve(cwd, tok.slice(eq + 1))));
    } else if (PREFIX_FLAGS.has(tok) && i + 1 < tokens.length) {
      targets.push(safeRealpath(NodePath.resolve(cwd, tokens[i + 1]!)));
      i += 1;
    }
  }
  return targets;
}

function isGlobalInstall(tokens: ReadonlyArray<string>): boolean {
  if (tokens.some((t) => GLOBAL_FLAGS.has(t))) return true;
  const cmd = NodePath.basename(tokens[0] ?? "");
  if (cmd === "yarn" && tokens[1] === "global") return true;
  if (
    (cmd === "pip" || cmd === "pip3" || cmd === "python" || cmd === "python3") &&
    tokens.includes("--user")
  ) {
    return true;
  }
  return false;
}

function isNodePackageInstall(tokens: ReadonlyArray<string>): boolean {
  if (tokens.length === 0) return false;
  const cmd = NodePath.basename(tokens[0]!);
  const subs = NODE_INSTALL_SUBS[cmd];
  if (!subs) return false;
  let sub: string | null = null;
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === "--") break;
    const name = tok.split("=", 1)[0] ?? "";
    if (PREFIX_FLAGS.has(tok)) {
      i += 1;
      continue;
    }
    if (PREFIX_FLAGS.has(name) || tok.startsWith("-")) continue;
    sub = tok;
    break;
  }
  if (sub === null) {
    // Bare `yarn` runs install; bare `pnpm`/`npm`/`bun`/`vp` prints help.
    return cmd === "yarn";
  }
  return subs.has(sub);
}

function isPythonVenv(tokens: ReadonlyArray<string>): boolean {
  if (tokens.length === 0) return false;
  const cmd = NodePath.basename(tokens[0]!);
  if ((cmd === "python" || cmd === "python3") && tokens.includes("-m")) {
    const idx = tokens.indexOf("-m");
    return tokens[idx + 1] === "venv";
  }
  return (cmd === "virtualenv" || cmd === "uv") && tokens.includes("venv");
}

function isPythonPackageInstall(tokens: ReadonlyArray<string>): boolean {
  if (tokens.length === 0) return false;
  const cmd = NodePath.basename(tokens[0]!);
  if ((cmd === "pip" || cmd === "pip3") && tokens.includes("install")) return true;
  if ((cmd === "python" || cmd === "python3") && tokens.includes("-m")) {
    const idx = tokens.indexOf("-m");
    const mod = tokens[idx + 1];
    return (mod === "pip" || mod === "pip3") && tokens.includes("install");
  }
  if (cmd === "uv" && tokens.includes("pip") && tokens.includes("install")) return true;
  if ((cmd === "uv" || cmd === "poetry") && tokens.includes("sync")) return true;
  if (cmd === "poetry" && tokens.includes("install")) return true;
  return false;
}

function extractGitWorktreeAddTarget(
  tokens: ReadonlyArray<string>,
  cwd: string,
): { readonly repoDir: string; readonly targetPath: string } | null {
  if (tokens.length < 3 || NodePath.basename(tokens[0]!) !== "git") return null;
  let repoDir = cwd;
  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    const a = tokens[i]!;
    if (a === "-C" && i + 1 < tokens.length) {
      repoDir = NodePath.resolve(repoDir, tokens[i + 1]!);
      i += 2;
      continue;
    }
    if (a === "-c" || a === "--git-dir" || a === "--work-tree") {
      i += 2;
      continue;
    }
    i += 1;
  }
  if (tokens[i] !== "worktree" || tokens[i + 1] !== "add") return null;
  const rest = tokens.slice(i + 2);
  const valueFlags = new Set(["-b", "-B", "--orphan", "--reason"]);
  for (let j = 0; j < rest.length; j += 1) {
    const a = rest[j]!;
    if (a === "--") {
      const next = rest[j + 1];
      return next ? { repoDir, targetPath: safeRealpath(NodePath.resolve(repoDir, next)) } : null;
    }
    if (valueFlags.has(a)) {
      j += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { repoDir, targetPath: safeRealpath(NodePath.resolve(repoDir, a)) };
  }
  return null;
}

function formatRemediation(repoName: string, config: HostGuardsConfig): string {
  const sourceDir = NodePath.join(config.sourceRoot, repoName);
  if (safeRealpath(config.sourceRoot) === safeRealpath(config.dataRoot)) {
    return (
      `Package installs are forbidden in primary checkout ${sourceDir}. ` +
      `Create or use a worktree under ${NodePath.join(config.sourceRoot, ".worktrees", repoName)}/<branch>, then install there.`
    );
  }
  const dataDir = NodePath.join(config.dataRoot, repoName);
  return (
    `Create or use a worktree at ${dataDir}/<name>, then install there. ` +
    `Do not install under ${sourceDir}.`
  );
}

export function decideInstallTokens(
  tokens: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
): GuardVerdict {
  const { command } = unwrapCommand(tokens);
  if (command.length === 0) return ALLOW_VERDICT;

  const wtAdd = extractGitWorktreeAddTarget(command, cwd);
  if (wtAdd) {
    const repoName = repoNameAt(wtAdd.repoDir, config);
    if (repoName && isUnderPath(wtAdd.targetPath, config.sourceRoot)) {
      const dataDir = NodePath.join(config.dataRoot, repoName);
      return {
        verdict: "deny",
        reason:
          `home-dev-install-guard: refusing \`git worktree add\` under ${config.sourceRoot} for ${repoName}.\n` +
          `  Create worktrees under ${dataDir}/<name> instead.`,
      };
    }
    return ALLOW_VERDICT;
  }

  if (isGlobalInstall(command)) return ALLOW_VERDICT;
  const isInstall =
    isNodePackageInstall(command) || isPythonPackageInstall(command) || isPythonVenv(command);
  if (!isInstall) return ALLOW_VERDICT;

  const candidateDirs = extractPrefixTargets(command.slice(1), cwd);
  const dirsToCheck = candidateDirs.length > 0 ? candidateDirs : [safeRealpath(cwd)];

  for (const dir of dirsToCheck) {
    if (!isUnderPath(dir, config.sourceRoot)) continue;
    // Allow installs in a dedicated worktree under dataRoot even if dataRoot sits inside sourceRoot.
    const sameRoot = safeRealpath(config.sourceRoot) === safeRealpath(config.dataRoot);
    if (!sameRoot && isUnderPath(dir, config.dataRoot)) continue;
    const repoName = repoNameAt(dir, config);
    if (!repoName) continue;
    return {
      verdict: "deny",
      reason:
        `home-dev-install-guard: refusing \`${NodePath.basename(command[0]!)}\` install inside ${dir}.\n` +
        `  ${formatRemediation(repoName, config)}`,
    };
  }
  return ALLOW_VERDICT;
}

export function decideInstallShellCommand(
  shellCommand: string,
  cwd: string,
  config: HostGuardsConfig,
): GuardVerdict {
  for (const words of simpleCommands(shellCommand)) {
    const verdict = decideInstallTokens(words, cwd, config);
    if (verdict.verdict === "deny") return verdict;
  }
  return ALLOW_VERDICT;
}

export function extractPackageScript(
  manager: string,
  args: ReadonlyArray<string>,
  cwd: string,
): { readonly script: string | null; readonly directory: string } {
  const base = NodePath.basename(manager);
  if (base !== "pnpm" && base !== "npm") {
    return { script: null, directory: cwd };
  }
  let directory = cwd;
  const valueFlags = base === "npm" ? NPM_VALUE_FLAGS : PM_VALUE_FLAGS;
  const words: string[] = [];

  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const tok = args[i]!;
    if (tok === "--") break;
    const eq = tok.indexOf("=");
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    if (valueFlags.has(flag) && eq !== -1) {
      if (PM_DIR_FLAGS.has(flag)) directory = NodePath.resolve(directory, tok.slice(eq + 1));
      continue;
    }
    if (valueFlags.has(tok)) {
      if (PM_DIR_FLAGS.has(tok) && i + 1 < args.length) {
        directory = NodePath.resolve(directory, args[i + 1]!);
      }
      i += 1;
      continue;
    }
    if (!tok.startsWith("-")) words.push(tok);
  }

  if (words.length === 0) return { script: null, directory };
  const cmd = words[0]!;
  if (cmd === "run" || cmd === "run-script") {
    return { script: words[1] ?? null, directory };
  }
  if (cmd === "test" || cmd === "t" || cmd === "tst") {
    return { script: "test", directory };
  }
  if (base === "pnpm" && !PM_BUILTINS.has(cmd)) {
    return { script: cmd, directory };
  }
  return { script: null, directory };
}
