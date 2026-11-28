// @effect-diagnostics nodeBuiltinImport:off - The repo's pre-push hook, run as a declared step before the queue's push.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { CiStep } from "./ciSteps.ts";
import type { ShipDeclaration } from "./declaration.ts";
import { git, remoteUrl } from "./gitQueries.ts";
import type { JobRecord, ProcessRunner } from "./types.ts";

const ZERO_SHA = "0".repeat(40);
const HOOK = "pre-push";

/**
 * Where the push's pre-push hook comes from. With `ship_hooks_path` it is the base's copy of that
 * directory (a branch never changes how it ships); without it, the hook git itself would run for
 * this checkout (`core.hooksPath` or `.git/hooks`), as the legacy queue's push ran it.
 */
export type PrePushSource =
  | { readonly kind: "base"; readonly dir: string }
  | { readonly kind: "repo"; readonly path: string };

export type PrePushPlan =
  | { readonly kind: "none" }
  | { readonly kind: "hook"; readonly source: PrePushSource }
  | { readonly kind: "fail"; readonly reason: string };

function isExecutableFile(path: string): boolean {
  try {
    if (!NodeFS.statSync(path).isFile()) return false;
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The path git resolves for `hooks/pre-push` here, reading the checkout's own `core.hooksPath`. */
async function repoHookPath(run: ProcessRunner, worktree: string): Promise<string | null> {
  const res = await run({
    command: "git",
    args: ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${HOOK}`],
    cwd: worktree,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return res.exitCode === 0 ? res.stdout.trim() || null : null;
}

/**
 * Whether the push has a pre-push hook to run. A `ship_ci=pre-push` repo with none fails: its CI
 * is that hook, and a push without it would merge unchecked work. Git skips a hook that is not
 * executable, so such a file is no hook (and fails a `pre-push` repo the same way).
 */
export async function planPrePush(
  run: ProcessRunner,
  job: JobRecord,
  decl: ShipDeclaration,
  onto: string,
  log: (text: string) => void,
): Promise<PrePushPlan> {
  const required = decl.ci.trim() === "pre-push";
  const missing = (why: string): PrePushPlan =>
    required
      ? { kind: "fail", reason: `ci step=${HOOK}: ${why} (ship_ci=pre-push)` }
      : { kind: "none" };
  if (decl.hooksPath) {
    const dir = decl.hooksPath.replace(/\/+$/, "");
    const spec = `${onto}:${dir}/${HOOK}`;
    if ((await git(run, job.primary, ["cat-file", "-e", spec])).exitCode !== 0) {
      return missing(`the base has no ${dir}/${HOOK}`);
    }
    const mode = (await git(run, job.primary, ["ls-tree", onto, "--", `${dir}/${HOOK}`])).stdout;
    if (!mode.startsWith("100755")) {
      log(`${dir}/${HOOK} in the base is not executable; git would not run it`);
      return missing(`the base's ${dir}/${HOOK} is not executable`);
    }
    return { kind: "hook", source: { kind: "base", dir } };
  }
  const path = await repoHookPath(run, job.worktree);
  if (!path || !NodeFS.existsSync(path)) return missing("no pre-push hook");
  if (!isExecutableFile(path)) {
    log(`${path} is not executable; git would not run it`);
    return missing(`${path} is not executable`);
  }
  return { kind: "hook", source: { kind: "repo", path } };
}

/**
 * The hook as a step: the base's hook directory is extracted into the job's step tree first (so a
 * hook's sibling scripts come along), and git's arguments and stdin for this one ref update are
 * handed to it. The hook runs in the job's worktree under the allowlisted CI environment; the
 * queue's push that follows holds the forge credentials and runs no hook itself.
 */
export async function prePushStep(input: {
  readonly run: ProcessRunner;
  readonly job: JobRecord;
  readonly onto: string;
  readonly head: string;
  readonly remoteTip: string | null;
  readonly stepTree: string;
  readonly source: PrePushSource;
  readonly timeoutMs: number;
}): Promise<
  { readonly ok: true; readonly step: CiStep } | { readonly ok: false; readonly error: string }
> {
  const { job, source } = input;
  let path: string;
  if (source.kind === "base") {
    const extract = await input.run({
      command: "bash",
      args: [
        "-c",
        'set -euo pipefail; mkdir -p "$3"; git -C "$1" archive --format=tar "$2" -- "$4" | tar -x -C "$3"',
        "--",
        job.primary,
        input.onto,
        input.stepTree,
        source.dir,
      ],
      cwd: job.primary,
    });
    if (extract.exitCode !== 0) {
      return {
        ok: false,
        error: extract.stderr.trim() || `hook extract exited ${extract.exitCode}`,
      };
    }
    path = NodePath.join(input.stepTree, source.dir, HOOK);
  } else {
    path = source.path;
  }
  const url = (await remoteUrl(input.run, job.worktree, job.remote)) ?? job.remote;
  const ref = `refs/heads/${job.branch}`;
  return {
    ok: true,
    step: {
      name: HOOK,
      cmdline: HOOK,
      withholdSecrets: false,
      timeoutMs: input.timeoutMs,
      hook: {
        path,
        args: [job.remote, url],
        stdin: `${ref} ${input.head} ${ref} ${input.remoteTip ?? ZERO_SHA}\n`,
      },
    },
  };
}
