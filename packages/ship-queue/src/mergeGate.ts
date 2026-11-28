// @effect-diagnostics nodeBuiltinImport:off - The declared `ship_merge_gate` on the landing path, right before the merge.
import * as NodePath from "node:path";

import { combinedOutput, runCiSteps } from "./ciSteps.ts";
import type { ShipDeclaration } from "./declaration.ts";
import { failureExcerpt } from "./failureExcerpt.ts";
import { gitOut } from "./gitQueries.ts";
import { appendLog, jobDir, updateJob } from "./jobStore.ts";
import { CI_TIMEOUT_MS, prepareStepTree, removeStepTree } from "./shipSteps.ts";
import { shouldWithholdSecretsForStage } from "./stepRunner.ts";
import type { JobRecord, ShipQueueDeps, StepTiming } from "./types.ts";

/** The gate's exit when its dependencies must be refreshed: the legacy queue's `dependency_refresh`. */
const DEPENDENCY_REFRESH_EXIT = 98;

export const mergeGateOutputPath = (root: string, id: string) =>
  NodePath.join(jobDir(root, id), "merge-gate-output.txt");

export type MergeGateOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "wait" }
  | { readonly kind: "fail"; readonly reason: string };

/**
 * Runs the declared `ship_merge_gate` where routing says, on the PR head the checkout must hold.
 * Exit 98 fails `dependency_refresh`, any other non-zero `merge_gate`. A recorded gate
 * (`ship_pass_record=merge`) gets no vendor token; a head it passed on is not run again.
 */
export async function runMergeGate(
  deps: ShipQueueDeps,
  job: JobRecord,
  decl: ShipDeclaration,
  rebase: { readonly onto: string; readonly head: string },
  pr: number,
): Promise<MergeGateOutcome> {
  const cmdline = decl.mergeGate.trim();
  if (!cmdline) return { kind: "pass" };
  const log = (text: string) => appendLog(deps.root, job.id, text);
  if (job.gate_tip === rebase.head) {
    log(`merge gate passed on ${rebase.head.slice(0, 12)} already`);
    return { kind: "pass" };
  }
  const headIsTip = async () =>
    (await gitOut(deps.run, job.worktree, ["rev-parse", "HEAD"])) === rebase.head;
  if (!(await headIsTip())) return { kind: "fail", reason: `head_moved_during_ci pr=${pr}` };
  const prepared = await prepareStepTree(deps, job, decl, rebase, {
    dataRoot: process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "",
    pr,
  });
  if (!prepared.ok) return { kind: "fail", reason: `steps_extract: ${prepared.error}` };
  const withhold = shouldWithholdSecretsForStage(decl, "merge");
  if (withhold) log("pass-record merge: the gate gets no vendor token (ship_pass_record=merge)");
  log(`=== merge gate for PR #${pr} at ${rebase.head.slice(0, 12)}`);
  const timings: StepTiming[] = [...(job.steps ?? [])];
  try {
    const gate = await runCiSteps({
      deps,
      job,
      decl,
      ctx: prepared.ctx,
      steps: [
        { name: "ship_merge_gate", cmdline, withholdSecrets: withhold, timeoutMs: CI_TIMEOUT_MS },
      ],
      remoteAllowed: true,
      timings,
      outputFile: mergeGateOutputPath(deps.root, job.id),
    });
    if (gate.kind === "wait") return { kind: "wait" };
    if (gate.kind === "cancelled") return { kind: "fail", reason: "cancelled" };
    if (gate.kind === "fail") {
      if (!gate.failed) return { kind: "fail", reason: gate.reason };
      log(failureExcerpt(combinedOutput(gate.failed.res)));
      return {
        kind: "fail",
        reason:
          gate.failed.res.exitCode === DEPENDENCY_REFRESH_EXIT
            ? `dependency_refresh pr=${pr}`
            : `merge_gate pr=${pr}`,
      };
    }
  } finally {
    removeStepTree(deps.root, job.id);
  }
  if (!(await headIsTip())) return { kind: "fail", reason: `head_moved_during_ci pr=${pr}` };
  updateJob(deps.root, job.id, { gate_tip: rebase.head });
  return { kind: "pass" };
}
