// @effect-diagnostics nodeBuiltinImport:off - A job's install and CI on a remote CI host: the run's refs, worktree, steps, and drop.
import { shellSingleQuote } from "@t3tools/ssh/command";

import type { CiHostEntry } from "./ciHosts.ts";
import type { CiServicePlan } from "./ciServicesPlan.ts";
import { remoteServiceShell, startCiServices, stopCiServices } from "./ciServicesRun.ts";
import { declaredStepPaths, type ShipDeclaration } from "./declaration.ts";
import { git } from "./gitQueries.ts";
import { runRemoteStep, type StepJobContext } from "./stepRunner.ts";
import { sshRemoteCommandRunner, type RemoteCommandRunner } from "./sshExec.ts";
import { buildToolchainShellSetup, formatDataRootShell } from "./toolchainEnv.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** The remote step runner's `cd <worktree> || exit 99`: the host, not the step, failed. */
export const REMOTE_INFRA_EXIT = 99;
/** ssh's own exit when the connection fails or drops. */
const SSH_LOST_EXIT = 255;

export interface RemoteStep {
  readonly name: string;
  readonly cmdline: string;
  readonly withholdSecrets: boolean;
  readonly timeoutMs: number;
}

export type RemoteCiResult =
  | { readonly kind: "infra"; readonly detail: string }
  /** The job's own files refuse its services there: no other host would start them either. */
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "ran" };

export interface RemoteCiInput {
  readonly host: CiHostEntry & { readonly ssh: string };
  readonly decl: ShipDeclaration;
  readonly ctx: StepJobContext & { readonly ontoSha: string; readonly tipSha: string };
  readonly body: string;
  readonly steps: ReadonlyArray<RemoteStep>;
  readonly secrets: Readonly<Record<string, string>>;
  /** The job's CI services, started in the run's worktree before the first step. */
  readonly services?: CiServicePlan | null | undefined;
  readonly run: ProcessRunner;
  readonly runRemote?: RemoteCommandRunner | undefined;
  readonly log: (text: string) => void;
  /** Called after each step; returning false stops the run (a failed step). */
  readonly onStep: (step: RemoteStep, res: ProcessResult, ms: number) => boolean;
  readonly nowMs: () => number;
}

const ciRef = (jobId: string, name: "steps" | "base" | "active") => `refs/ci/${jobId}/${name}`;
const ciBranch = (jobId: string) => `ship-queue-ci-${jobId}`;

function remoteBaseRef(baseRef: string): string {
  if (baseRef.startsWith("refs/")) return baseRef;
  return `refs/remotes/${baseRef || "origin/main"}`;
}

/** The host's own checkout of the repo, ~/Dev/<ship_repo>, cloned from GitHub when it has none. */
function ensureCloneScript(setup: string, repo: string, ghRepo: string): string {
  const dir = `"$HOME/Dev/"${shellSingleQuote(repo)}`;
  const url = shellSingleQuote(`https://github.com/${ghRepo}.git`);
  return `${setup}
d=${dir}
if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then echo "ok $d"; else mkdir -p "$HOME/Dev" && GIT_TERMINAL_PROMPT=0 git clone -q ${url} "$d" && echo "cloned $d"; fi`;
}

/**
 * The run's worktree at the pushed tip, filled by reset (no checkout hooks run), with the pinned
 * base's copy of the declared step paths and the PR body inside its own git dir.
 */
function setupScript(input: {
  readonly setup: string;
  readonly clone: string;
  readonly dataRootShell: string;
  readonly key: string;
  readonly jobId: string;
  readonly paths: ReadonlyArray<string>;
}): string {
  const q = shellSingleQuote;
  const paths = input.paths.map(q).join(" ");
  const branch = q(ciBranch(input.jobId));
  return `${input.setup}
c=${q(input.clone)} wt="${input.dataRootShell}/ci/"${q(`${input.key}/${input.jobId}`)}
fail() { cd "$c" && { git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; git worktree prune; git branch -D -q ${branch} 2>/dev/null; }; exit 1; }
cd "$c" || exit 1
if [ -e "$wt" ]; then git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; git worktree prune; fi
mkdir -p "\${wt%/*}" && git worktree add -q -f --no-checkout -B ${branch} "$wt" ${q(ciRef(input.jobId, "active"))} || fail
cd "$wt" && git reset -q --hard --no-recurse-submodules && g=$(git rev-parse --absolute-git-dir) || fail
rm -rf "$g/ship-queue-base" && mkdir -p "$g/ship-queue-base" || fail
${paths ? `git archive ${q(ciRef(input.jobId, "steps"))} -- ${paths} | tar -x -C "$g/ship-queue-base" || fail` : ":"}
cat > "$g/ship-queue-body.md" || fail
echo "wt $wt"`;
}

function dropScript(clone: string, worktree: string, jobId: string): string {
  const q = shellSingleQuote;
  const refs = (["steps", "base", "active"] as const).map((r) => q(ciRef(jobId, r))).join(" ");
  return `cd ${q(clone)} || exit 0
git worktree remove --force ${q(worktree)} 2>/dev/null || rm -rf ${q(worktree)}
git worktree prune
git branch -D -q ${q(ciBranch(jobId))} 2>/dev/null
for r in ${refs}; do git update-ref -d "$r" 2>/dev/null; done
exit 0`;
}

function lastLine(text: string, prefix: string): string | null {
  const line = text
    .trim()
    .split("\n")
    .toReversed()
    .find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

/**
 * Runs the declared steps on `host`. The run's refs are pushed fresh into the host's checkout, so
 * the host never needs GitHub credentials to fetch them. Any failure before a step runs is
 * `infra`: the caller runs the steps on this host instead.
 */
export async function runRemoteCi(input: RemoteCiInput): Promise<RemoteCiResult> {
  const { host, decl, ctx } = input;
  const ghRepo = decl.ghRepo || ctx.ghRepo || "";
  const repo = decl.repo || ghRepo.split("/")[1] || "";
  if (!NAME_RE.test(repo) || !GH_REPO_RE.test(ghRepo) || !NAME_RE.test(ctx.jobId)) {
    return { kind: "infra", detail: `repo '${repo}' or '${ghRepo}' is not a safe remote path` };
  }
  const runRemote = input.runRemote ?? sshRemoteCommandRunner;
  let dataRootShell: string;
  try {
    dataRootShell = formatDataRootShell(host.data_root);
  } catch (err) {
    return { kind: "infra", detail: err instanceof Error ? err.message : String(err) };
  }
  const setup = buildToolchainShellSetup({ dataRootShell });

  const clone = await runRemote(host.ssh, ensureCloneScript(setup, repo, ghRepo), {
    timeoutMs: 900_000,
  });
  const cloneDir = lastLine(clone.stdout, "ok ") ?? lastLine(clone.stdout, "cloned ");
  if (clone.exitCode !== 0 || !cloneDir) {
    return {
      kind: "infra",
      detail: `no checkout of ${ghRepo} on ${host.name}: ${clone.stderr.trim() || `exit ${clone.exitCode}`}`,
    };
  }

  const push = await git(input.run, ctx.worktree, [
    "-c",
    "core.sshCommand=ssh -o BatchMode=yes",
    "push",
    "--force",
    "-q",
    `ssh://${host.ssh}${cloneDir}`,
    `${ctx.baseSha}:${ciRef(ctx.jobId, "steps")}`,
    `${ctx.ontoSha}:${ciRef(ctx.jobId, "base")}`,
    `${ctx.tipSha}:${ciRef(ctx.jobId, "active")}`,
    `${ctx.ontoSha}:${remoteBaseRef(decl.baseRef)}`,
  ]);
  const drop = async (worktree: string) => {
    await runRemote(host.ssh, dropScript(cloneDir, worktree, ctx.jobId), { timeoutMs: 120_000 });
  };
  if (push.exitCode !== 0) {
    await drop(`${cloneDir}/.ship-queue-none`);
    return {
      kind: "infra",
      detail: `push to ${host.name} failed: ${push.stderr.trim() || `exit ${push.exitCode}`}`,
    };
  }

  const key = ghRepo.replace("/", "_");
  const prepared = await runRemote(
    host.ssh,
    setupScript({
      setup,
      clone: cloneDir,
      dataRootShell,
      key,
      jobId: ctx.jobId,
      paths: declaredStepPaths(decl),
    }),
    { stdin: input.body, timeoutMs: 900_000 },
  );
  const worktree = lastLine(prepared.stdout, "wt ");
  if (prepared.exitCode !== 0 || !worktree) {
    await drop(worktree ?? `${cloneDir}/.ship-queue-none`);
    return {
      kind: "infra",
      detail: `setup on ${host.name} failed: ${`${prepared.stdout}${prepared.stderr}`.trim() || `exit ${prepared.exitCode}`}`,
    };
  }

  const services = input.services ?? null;
  const serviceShell = remoteServiceShell({
    runRemote,
    ssh: host.ssh,
    toolchainSetup: setup,
    worktree,
  });
  try {
    let stepCtx: StepJobContext & { readonly ontoSha: string; readonly tipSha: string } = ctx;
    if (services) {
      const started = await startCiServices(serviceShell, services, input.log);
      if (started.kind === "refused") return { kind: "refused", detail: started.reason };
      if (started.kind === "failed") {
        return { kind: "infra", detail: `services on ${host.name}: ${started.reason}` };
      }
      stepCtx = { ...ctx, ciServiceEnv: started.env };
    }
    input.log(`running CI on ${host.name} (worktree ${worktree} of ${cloneDir})`);
    for (const [index, step] of input.steps.entries()) {
      const started = input.nowMs();
      const res = await runRemoteStep({
        sshAlias: host.ssh,
        remoteWorktree: worktree,
        remoteDataRootDeclared: host.data_root,
        ctx: stepCtx,
        cmdline: step.cmdline,
        secrets: input.secrets,
        withholdSecrets: step.withholdSecrets,
        timeoutMs: step.timeoutMs,
        runRemote,
      });
      if (res.exitCode === SSH_LOST_EXIT || (index === 0 && res.exitCode === REMOTE_INFRA_EXIT)) {
        return {
          kind: "infra",
          detail: `${host.name} lost ${step.name} (exit ${res.exitCode}): ${res.stderr.trim().split("\n").at(-1) ?? ""}`,
        };
      }
      if (!input.onStep(step, res, input.nowMs() - started)) break;
    }
    return { kind: "ran" };
  } finally {
    // Pass, fail, a lost step or a cancel: the job's project goes before its worktree.
    if (services) await stopCiServices(serviceShell, services, input.log);
    await drop(worktree);
  }
}
