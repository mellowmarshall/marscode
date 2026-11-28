// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Runs a repo's declared body check, install, and CI before its merge, timing each step.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ciOutputPath, combinedOutput, runCiSteps, type CiStep } from "./ciSteps.ts";
import type { RemoteStep } from "./ciRemote.ts";
import { parseShipDeclaration, type ShipDeclaration } from "./declaration.ts";
import { extractBaseStepTree } from "./declarationValidation.ts";
import { failureExcerpt } from "./failureExcerpt.ts";
import { git, gitOut } from "./gitQueries.ts";
import { planPrePush, prePushStep } from "./prePushCi.ts";
import { appendLog, jobBodyPath, jobDir, mark, updateJob } from "./jobStore.ts";
import { runLocalStep, type StepJobContext } from "./stepRunner.ts";
import type { JobRecord, ShipQueueDeps, StepTiming } from "./types.ts";

const MINUTE_MS = 60_000;
const BODY_TIMEOUT_MS = 5 * MINUTE_MS;
const INSTALL_TIMEOUT_MS = 30 * MINUTE_MS;
export const CI_TIMEOUT_MS = 90 * MINUTE_MS;
const MERGE_TIMEOUT_MS = 10 * MINUTE_MS;

export type StepsOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "wait" }
  | { readonly kind: "fail"; readonly reason: string };

const stepTreePath = (root: string, id: string) =>
  NodePath.join(jobDir(root, id), "work", "step-tree");

/**
 * The base's declaration: a branch never changes how it ships. A base with no `.tree-guard.conf`
 * declares nothing; one git cannot read throws, so the job fails instead of skipping its CI.
 */
export async function readBaseDeclaration(
  deps: ShipQueueDeps,
  job: JobRecord,
  onto: string,
): Promise<ShipDeclaration | null> {
  const spec = `${onto}:.tree-guard.conf`;
  if ((await git(deps.run, job.primary, ["cat-file", "-e", spec])).exitCode !== 0) return null;
  const conf = await gitOut(deps.run, job.primary, ["show", spec]);
  if (conf === null) throw new Error(`cannot read ${spec} in ${job.primary}`);
  const playbook = (await gitOut(deps.run, job.primary, ["show", `${onto}:playbook.json`])) ?? "";
  return parseShipDeclaration(conf, playbook, ".tree-guard.conf");
}

/** The base's copy of every declared step script, extracted beside the job; the context its steps get. */
export async function prepareStepTree(
  deps: ShipQueueDeps,
  job: JobRecord,
  decl: ShipDeclaration,
  rebase: { readonly onto: string; readonly head: string },
  extra: { readonly dataRoot: string; readonly pr?: number | undefined },
): Promise<
  | { readonly ok: true; readonly ctx: StepJobContext }
  | { readonly ok: false; readonly error: string }
> {
  const stepTree = stepTreePath(deps.root, job.id);
  const extracted = await extractBaseStepTree({
    run: deps.run,
    primary: job.primary,
    baseSha: rebase.onto,
    decl,
    destDir: stepTree,
  });
  if (!extracted.ok)
    return { ok: false, error: extracted.error ?? "base step tree extract failed" };
  NodeFS.mkdirSync(NodePath.join(jobDir(deps.root, job.id), "work"), { recursive: true });
  return {
    ok: true,
    ctx: {
      jobId: job.id,
      repo: job.repo,
      primary: job.primary,
      worktree: job.worktree,
      branch: job.branch,
      baseRef: decl.baseRef || `${job.remote}/${job.base_branch}`,
      baseSha: rebase.onto,
      ontoSha: rebase.onto,
      tipSha: rebase.head,
      ghRepo: decl.ghRepo || job.repo,
      queueRoot: deps.root,
      stepTree,
      dataRoot: extra.dataRoot,
      pr: extra.pr,
      worktreeRoot: decl.worktreeRoot || undefined,
    },
  };
}

export function removeStepTree(root: string, id: string): void {
  NodeFS.rmSync(stepTreePath(root, id), { recursive: true, force: true });
}

/**
 * Runs the declared `ship_body_check`, `ship_install`, and `ship_ci` against the rebased head,
 * install and CI on the host routing picks, then the push's pre-push hook here (the CI of a
 * `ship_ci=pre-push` repo). A head the steps already passed on is not run again (a resumed job).
 */
export async function runDeclaredSteps(
  deps: ShipQueueDeps,
  job: JobRecord,
  rebase: { readonly onto: string; readonly head: string; readonly remoteTip?: string | null },
): Promise<StepsOutcome> {
  const decl = await readBaseDeclaration(deps, job, rebase.onto);
  if (!decl) return { kind: "pass" };
  const log = (text: string) => appendLog(deps.root, job.id, text);
  const prePush = decl.ci.trim() === "pre-push";
  const ciCmd = prePush ? "" : decl.ci.trim();
  const ciSteps: RemoteStep[] = [
    ...(decl.install.trim()
      ? [
          {
            name: "ship_install",
            cmdline: decl.install.trim(),
            withholdSecrets: true,
            timeoutMs: INSTALL_TIMEOUT_MS,
          },
        ]
      : []),
    ...(ciCmd
      ? [{ name: "ship_ci", cmdline: ciCmd, withholdSecrets: false, timeoutMs: CI_TIMEOUT_MS }]
      : []),
  ];
  if (job.steps_tip === rebase.head) {
    log(`declared steps passed on ${rebase.head.slice(0, 12)} already`);
    return { kind: "pass" };
  }
  const hook = await planPrePush(deps.run, job, decl, rebase.onto, log);
  if (hook.kind === "fail") return { kind: "fail", reason: hook.reason };
  if (!decl.bodyCheck.trim() && ciSteps.length === 0 && hook.kind === "none") {
    return { kind: "pass" };
  }
  const prepared = await prepareStepTree(deps, job, decl, rebase, {
    dataRoot: process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "",
  });
  if (!prepared.ok) return { kind: "fail", reason: `steps_extract: ${prepared.error}` };
  const ctx = prepared.ctx;
  const timings: StepTiming[] = [];
  const waiting = job.ci_wait?.tip === rebase.head;
  if (!waiting) NodeFS.rmSync(ciOutputPath(deps.root, job.id), { force: true });
  try {
    // A job waiting for a CI host passed its body check already; it is not run on every retry.
    if (decl.bodyCheck.trim() && !waiting) {
      const started = Date.now();
      const res = await runLocalStep({
        mode: "stage",
        ctx,
        cmdline: decl.bodyCheck.trim(),
        extraArgs: [jobBodyPath(deps.root, job.id)],
        timeoutMs: BODY_TIMEOUT_MS,
        run: deps.run,
      });
      const ms = Date.now() - started;
      timings.push({ name: "ship_body_check", host: "local", exit: res.exitCode, ms });
      updateJob(deps.root, job.id, { steps: [...timings] });
      mark(deps.root, job.id, `STEP name=ship_body_check host=local exit=${res.exitCode} ms=${ms}`);
      if (res.exitCode !== 0) {
        log(failureExcerpt(combinedOutput(res)));
        return { kind: "fail", reason: `ci step=ship_body_check exit=${res.exitCode}` };
      }
    } else if (waiting) {
      timings.push(...(job.steps ?? []));
    }
    const runSteps = async (
      steps: ReadonlyArray<CiStep>,
      remoteAllowed: boolean,
      appendOutput: boolean,
    ): Promise<StepsOutcome | null> => {
      const ci = await runCiSteps({
        deps,
        job,
        decl,
        ctx,
        steps,
        remoteAllowed,
        timings,
        appendOutput,
      });
      if (ci.kind === "wait") return { kind: "wait" };
      if (ci.kind === "cancelled") return { kind: "fail", reason: "cancelled" };
      if (ci.kind === "fail") {
        if (ci.failed) log(failureExcerpt(combinedOutput(ci.failed.res)));
        return { kind: "fail", reason: ci.reason };
      }
      return null;
    };
    // A pre-push repo's install serves its hook here, so it never leaves this host.
    if (ciSteps.length > 0) {
      const stopped = await runSteps(ciSteps, ciCmd !== "", false);
      if (stopped) return stopped;
    }
    if (hook.kind === "hook") {
      const step = await prePushStep({
        run: deps.run,
        job,
        onto: rebase.onto,
        head: rebase.head,
        remoteTip: rebase.remoteTip ?? null,
        stepTree: ctx.stepTree,
        source: hook.source,
        timeoutMs: CI_TIMEOUT_MS,
      });
      if (!step.ok) return { kind: "fail", reason: `steps_extract: ${step.error}` };
      const stopped = await runSteps([step.step], false, ciSteps.length > 0);
      if (stopped) return stopped;
      // The hook judged the checkout: it counts only while that is still the tip the queue pushes.
      if ((await gitOut(deps.run, job.worktree, ["rev-parse", "HEAD"])) !== rebase.head) {
        return { kind: "fail", reason: "head_moved_during_ci" };
      }
    }
    return passed(deps, job, rebase.head);
  } finally {
    removeStepTree(deps.root, job.id);
  }
}

function passed(deps: ShipQueueDeps, job: JobRecord, head: string): StepsOutcome {
  updateJob(deps.root, job.id, { steps_tip: head });
  return { kind: "pass" };
}

export type MergeStepOutcome =
  | { readonly kind: "merged"; readonly output: string }
  | { readonly kind: "retry"; readonly exit: number; readonly output: string }
  | { readonly kind: "fail"; readonly exit: number; readonly output: string; readonly why: string };

/**
 * The declared `ship_merge PR`: 0 merged, 75 the base moved (the job lands again from its
 * rebase), 76 transient. Runs the base's copy here with the forge's credentials (as post-merge does).
 */
export async function runMergeStep(
  deps: ShipQueueDeps,
  job: JobRecord,
  decl: ShipDeclaration,
  rebase: { readonly onto: string; readonly head: string },
  pr: number,
): Promise<MergeStepOutcome> {
  const prepared = await prepareStepTree(deps, job, decl, rebase, {
    dataRoot: process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "",
    pr,
  });
  if (!prepared.ok) return { kind: "fail", exit: 1, output: "", why: prepared.error };
  const reasonFile = NodePath.join(jobDir(deps.root, job.id), "work", "reason");
  NodeFS.rmSync(reasonFile, { force: true });
  try {
    const started = Date.now();
    const res = await runLocalStep({
      mode: "stage",
      ctx: prepared.ctx,
      cmdline: decl.merge.trim(),
      extraArgs: [String(pr)],
      forge: true,
      timeoutMs: MERGE_TIMEOUT_MS,
      run: deps.run,
    });
    const ms = Date.now() - started;
    const steps = [
      ...(job.steps ?? []),
      { name: "ship_merge", host: "local", exit: res.exitCode, ms },
    ];
    updateJob(deps.root, job.id, { steps });
    mark(deps.root, job.id, `STEP name=ship_merge host=local exit=${res.exitCode} ms=${ms}`);
    const output = combinedOutput(res);
    if (res.exitCode === 0) return { kind: "merged", output };
    if (res.exitCode === 75 || res.exitCode === 76)
      return { kind: "retry", exit: res.exitCode, output };
    let why = "";
    try {
      why = NodeFS.readFileSync(reasonFile, "utf8").trim().split("\n")[0] ?? "";
    } catch {
      why = output.split("\n").at(-1) ?? "";
    }
    return { kind: "fail", exit: res.exitCode, output, why };
  } finally {
    removeStepTree(deps.root, job.id);
  }
}
