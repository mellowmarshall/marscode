// @effect-diagnostics nodeBuiltinImport:off - House stages: secret scan, protected-diff grant check, and advisory declaration challenge.
import * as NodeFS from "node:fs";

import { inspectWorktreeBundle } from "@t3tools/guard-protocol/bundle-inspect";
import { checkGuardGrant } from "@t3tools/guard-protocol/client";
import { computeBundleKey } from "@t3tools/guard-protocol/digests";

import { appendLog, mark, updateJob } from "./jobStore.ts";
import type {
  DeclarationChallenger,
  JobRecord,
  ProcessRunner,
  SecretScanner,
  ShipGuard,
  ShipQueueDeps,
} from "./types.ts";

export type HouseResult =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly reason: string }
  | { readonly kind: "action"; readonly digest: string };

/** The grant command a bundled approval binds to, as the broker's inspector reads it. */
export function shipGrantCommand(worktree: string, branch: string): ReadonlyArray<string> {
  return ["ship-queue", "submit", worktree, branch];
}

/** `#6` guard-protocol: bundle inspection and the check-first grant lookup, with no local digest logic. */
export const guardProtocolGuard: ShipGuard = {
  inspect: ({ worktree, branch, baseRef }) =>
    inspectWorktreeBundle({
      guard: "ship-queue",
      command: shipGrantCommand(worktree, branch),
      cwd: worktree,
      worktree,
      branch,
      baseRef,
    }),
  check: async ({ worktree, branch, bundle }) => {
    const reply = await checkGuardGrant({
      guard: "ship-queue",
      command: shipGrantCommand(worktree, branch),
      cwd: worktree,
      bundle,
    });
    return { ok: reply.ok, reason: reply.error ?? reply.reason };
  },
};

/** `gitleaks` over the job's own commits; `null` when the host has no scanner. */
export function gitleaksScanner(run: ProcessRunner): SecretScanner {
  return async ({ worktree, baseSha }) => {
    let res;
    try {
      res = await run({
        command: "gitleaks",
        args: ["git", `--log-opts=${baseSha}..HEAD`, "--no-banner", "--redact", "--exit-code", "1"],
        cwd: worktree,
      });
    } catch {
      return null;
    }
    if (res.exitCode === 0) return [];
    if (res.exitCode !== 1) return null;
    const summary = `${res.stdout}${res.stderr}`.trim().split("\n").slice(-3).join(" ");
    return [{ summary: summary || "gitleaks reported leaks" }];
  };
}

const CHALLENGE_TIMEOUT_MS = 960_000;

/** Runs `playbook challenge --advisory` against the real worktree and ensures `outFile` holds a report. */
export function playbookDeclarationChallenger(run: ProcessRunner): DeclarationChallenger {
  return async ({ jobId, worktree, baseSha, tipSha, bodyFile, outFile, threadId }) => {
    const env: Record<string, string> = {
      SHIP_QUEUE_JOB: jobId,
      SHIP_QUEUE_BODYFILE: bodyFile,
      PLAYBOOK_CHALLENGE_ADVISORY: "1",
      ...(threadId ? { T3CODE_THREAD_ID: threadId } : {}),
    };
    let res;
    try {
      res = await run({
        command: "playbook",
        args: ["challenge", "--advisory", "--base", baseSha, "--tip", tipSha, "--out", outFile],
        cwd: worktree,
        env,
        timeoutMs: CHALLENGE_TIMEOUT_MS,
      });
    } catch {
      const report = "PLAYBOOK REVIEW: NOT RUN\n  playbook is not installed on this host\n";
      NodeFS.writeFileSync(outFile, report, "utf8");
      return {
        output: "house declaration-challenge: advisory (playbook is not installed on this host)",
        report,
      };
    }
    const output = `${res.stdout}${res.stderr}`.trim();
    let report = "";
    try {
      report = NodeFS.readFileSync(outFile, "utf8").trim();
    } catch {
      report = "";
    }
    if (!report) {
      report = output || "PLAYBOOK REVIEW: NOT RUN\n  challenger produced no report";
      NodeFS.writeFileSync(outFile, `${report}\n`, "utf8");
    }
    return { output, report };
  };
}

export async function houseStages(
  deps: ShipQueueDeps,
  job: JobRecord,
  onto: string,
): Promise<HouseResult> {
  const findings = await deps.secretScan({ worktree: job.worktree, baseSha: onto });
  if (findings === null) {
    appendLog(deps.root, job.id, "secret scan skipped: no scanner on this host");
  } else if (findings.length > 0) {
    appendLog(deps.root, job.id, findings.map((f) => f.summary).join("\n"));
    return { kind: "fail", reason: "house_secret_scan" };
  }

  const bundle = deps.guard.inspect({ worktree: job.worktree, branch: job.branch, baseRef: onto });
  if (!bundle) return { kind: "pass" };
  const digest = computeBundleKey({
    repo: bundle.repo,
    branch: bundle.branch,
    prOrIssue: bundle.pr_or_issue,
    guard: "ship-queue",
    gateIds: bundle.gates.map((g) => g.gate_id),
    protectedPaths: bundle.protected_paths,
    protectedDiffSha256: bundle.protected_diff_sha256,
    bodySha256: bundle.body_sha256,
  });
  const grant = await deps.guard.check({ worktree: job.worktree, branch: job.branch, bundle });
  if (grant.ok) {
    appendLog(deps.root, job.id, `protected diff approved: ${bundle.protected_paths.join(", ")}`);
    return { kind: "pass" };
  }
  if (job.action_digest !== digest) {
    const gates = bundle.gates.map((g) => g.gate_id).join(",");
    mark(
      deps.root,
      job.id,
      `ACTION_REQUIRED job=${job.id} gates=${gates} paths=${bundle.protected_paths.join(",")} digest=${digest}: the owner approves this protected diff (marscode-guard override ship-queue), then re-arm the watch`,
    );
    updateJob(deps.root, job.id, { action_digest: digest });
  }
  return { kind: "action", digest };
}
