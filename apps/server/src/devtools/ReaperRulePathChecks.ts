// @effect-diagnostics nodeBuiltinImport:off - Git-repository and /data checks for cleanup rule paths, on canonical paths, at save and sweep time.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

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

/** Whether git tracks anything at or under a path in a checkout; null when git could not answer. */
export type GitTracksFiles = (checkout: string, canonicalPath: string) => Promise<boolean | null>;

const GIT_CHECK_TIMEOUT = "10 seconds";

/** `git ls-files` through the server's process runner, off the event loop and bounded in time. */
export const makeGitTracksFiles = Effect.fn("ReaperRulePathChecks.makeGitTracksFiles")(
  function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const hostEnv = yield* HostProcess.Environment;
    // The runner extends the server's env; undefined clears each inherited variable, so no
    // GIT_DIR or GIT_CONFIG_* reaches git.
    const inherited = new Set([...Object.keys(hostEnv), ...Object.keys(process.env)]);
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries([...inherited].map((key) => [key, undefined])),
      PATH: hostEnv.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const tracksFiles: GitTracksFiles = (checkout, canonicalPath) =>
      runPromise(
        runner
          .run({
            command: "git",
            args: [...HARDENED_GIT_CONFIG, "-C", checkout, "ls-files", "-z", "--", canonicalPath],
            env,
            timeout: GIT_CHECK_TIMEOUT,
            maxOutputBytes: 4096,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((out) => (out.code === 0 && !out.timedOut ? out.stdout.length > 0 : null)),
            Effect.orElseSucceed(() => null),
          ),
      ).catch(() => null);
    return tracksFiles;
  },
);

/**
 * Refuses git data, bare repos, and anything inside a checkout except untracked build output.
 * Runs when a rule is saved and again before each sweep, since a parent can become a repo later.
 */
export async function gitRuleRefusal(
  canonicalPath: string,
  tracksFiles: GitTracksFiles,
): Promise<string | null> {
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
  const tracked = await tracksFiles(checkout, canonicalPath);
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
