// @effect-diagnostics nodeBuiltinImport:off - The repo's pre-push hook, run as a declared step before the queue's push.
import * as NodePath from "node:path";

import type { CiStep } from "./ciSteps.ts";
import type { ShipDeclaration } from "./declaration.ts";
import { git, remoteUrl } from "./gitQueries.ts";
import type { JobRecord, ProcessRunner } from "./types.ts";

const ZERO_SHA = "0".repeat(40);
const HOOK = "pre-push";

/** The base's copy of the `ship_hooks_path` directory: a branch never changes how it ships. */
export type PrePushSource = { readonly kind: "base"; readonly dir: string };

export type PrePushPlan =
  | { readonly kind: "none" }
  | { readonly kind: "hook"; readonly source: PrePushSource }
  | { readonly kind: "fail"; readonly reason: string };

/**
 * Only a `ship_ci=pre-push` repo runs a hook, and only the base's `ship_hooks_path` copy: a
 * checkout's own hook path can resolve inside the branch or be rewritten by install. A missing
 * `ship_hooks_path` or base hook fails the job instead of merging unchecked work.
 */
export async function planPrePush(
  run: ProcessRunner,
  job: JobRecord,
  decl: ShipDeclaration,
  onto: string,
  log: (text: string) => void,
): Promise<PrePushPlan> {
  if (decl.ci.trim() !== "pre-push") return { kind: "none" };
  const fail = (why: string): PrePushPlan => ({
    kind: "fail",
    reason: `ci step=${HOOK}: ${why} (ship_ci=pre-push)`,
  });
  if (!decl.hooksPath) return fail("declare ship_hooks_path so the hook comes from the base");
  const dir = decl.hooksPath.replace(/\/+$/, "");
  const spec = `${onto}:${dir}/${HOOK}`;
  if ((await git(run, job.primary, ["cat-file", "-e", spec])).exitCode !== 0) {
    return fail(`the base has no ${dir}/${HOOK}`);
  }
  const mode = (await git(run, job.primary, ["ls-tree", onto, "--", `${dir}/${HOOK}`])).stdout;
  if (!mode.startsWith("100755")) {
    log(`${dir}/${HOOK} in the base is not executable; git would not run it`);
    return fail(`the base's ${dir}/${HOOK} is not executable`);
  }
  return { kind: "hook", source: { kind: "base", dir } };
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
  const path = NodePath.join(input.stepTree, source.dir, HOOK);
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
