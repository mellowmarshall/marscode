// @effect-diagnostics nodeBuiltinImport:off - Git-repository and /data checks for cleanup rule paths, on canonical paths, at save and sweep time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Build output a checkout regenerates; the only rule targets allowed inside one. */
const BUILD_OUTPUT_NAMES = new Set([
  "target",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
]);
const TMP_CACHE_NAMES = new Set(["tmp", "temp", ".tmp", "cache", "caches", ".cache"]);

// Read-only git, with no hooks, fsmonitor, or user and system config.
const HARDENED_GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
].flatMap((setting) => ["-c", setting]);

const isDir = (target: string) => {
  try {
    return NodeFS.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const exists = (target: string) => {
  try {
    return NodeFS.existsSync(target);
  } catch {
    return false;
  }
};

/** Git's own data: a `*.git` directory (`.git`, `foo.git`, any case) or a bare repo or mirror. */
function isGitDataDir(dir: string): boolean {
  if (NodePath.basename(dir).toLowerCase().endsWith(".git")) return true;
  return (
    exists(NodePath.join(dir, "HEAD")) &&
    isDir(NodePath.join(dir, "objects")) &&
    isDir(NodePath.join(dir, "refs"))
  );
}

function ancestorsAndSelf(canonicalPath: string): string[] {
  const out: string[] = [];
  let cursor = canonicalPath;
  while (true) {
    out.push(cursor);
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) return out;
    cursor = parent;
  }
}

/** The nearest directory at or above `canonicalPath` that holds a `.git` entry. */
export function gitCheckoutAt(canonicalPath: string): string | null {
  return ancestorsAndSelf(canonicalPath).find((dir) => exists(NodePath.join(dir, ".git"))) ?? null;
}

/** Whether git tracks anything at or under `canonicalPath`; null when git could not answer. */
function tracksFiles(checkout: string, canonicalPath: string): boolean | null {
  const result = NodeChildProcess.spawnSync(
    "git",
    [...HARDENED_GIT_CONFIG, "-C", checkout, "ls-files", "-z", "--", canonicalPath],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout.length > 0;
}

/**
 * Refuses git data, bare repos, and anything inside a checkout except untracked build output.
 * Runs when a rule is saved and again before each sweep, since a parent can become a repo later.
 */
export function gitRuleRefusal(canonicalPath: string): string | null {
  const gitData = ancestorsAndSelf(canonicalPath).find(isGitDataDir);
  if (gitData !== undefined) {
    return `Refusing cleanup rule inside git repository data ${gitData}: ${canonicalPath}`;
  }
  const checkout = gitCheckoutAt(canonicalPath);
  if (checkout === null) return null;
  if (checkout === canonicalPath) {
    return `Refusing active git checkout/worktree root: ${canonicalPath}`;
  }
  if (!BUILD_OUTPUT_NAMES.has(NodePath.basename(canonicalPath))) {
    return `Refusing cleanup rule inside git checkout ${checkout}; only build output (${[...BUILD_OUTPUT_NAMES].join(", ")}) may be targeted there: ${canonicalPath}`;
  }
  const tracked = tracksFiles(checkout, canonicalPath);
  if (tracked === null) {
    return `Refusing cleanup rule inside git checkout ${checkout}: could not check it for tracked files: ${canonicalPath}`;
  }
  return tracked
    ? `Refusing cleanup rule that contains tracked files of git checkout ${checkout}: ${canonicalPath}`
    : null;
}

/** Agent proposals under /data must end in build output, tmp, or cache; a user's own rule need not. */
export function dataProposalRefusal(canonicalPath: string): string | null {
  if (!canonicalPath.startsWith("/data/")) return null;
  const last = NodePath.basename(canonicalPath);
  if (BUILD_OUTPUT_NAMES.has(last) || TMP_CACHE_NAMES.has(last)) return null;
  return `Refusing proposed rule under /data that is not build output, tmp, or cache: ${canonicalPath}`;
}
