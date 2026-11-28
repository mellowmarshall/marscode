// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - A job's install and CI on the host routing picks, timed, with their output kept for the review.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ActiveRouteLease } from "./ciRouter.ts";
import type { CiPlacement } from "./ciPlacement.ts";
import { runRemoteCi, type RemoteStep } from "./ciRemote.ts";
import { planCiServices, plannedServiceNames, type CiServicePlan } from "./ciServicesPlan.ts";
import { localServiceShell, startCiServices, stopCiServices } from "./ciServicesRun.ts";
import type { ShipDeclaration } from "./declaration.ts";
import {
  appendLog,
  cancelRequested,
  isEnded,
  jobBodyPath,
  jobDir,
  listJobIds,
  mark,
  readJob,
  updateJob,
} from "./jobStore.ts";
import { runLocalStep, type StepHook, type StepJobContext } from "./stepRunner.ts";
import type { JobRecord, ProcessResult, ShipQueueDeps, StepTiming } from "./types.ts";

const HEARTBEAT_MS = 60_000;
/** How often a job no CI host can take asks routing again; each ask logs, so its watch stays live. */
const CI_WAIT_RETRY_MS = 60_000;
/** A job no CI host takes within this stops holding its repo's queue. */
const CI_WAIT_LIMIT_MS = 60 * 60_000;

/** Where the playbook challenge reads the job's CI results (`playbook challenge`'s `jobCiOutput`). */
export const ciOutputPath = (root: string, id: string) =>
  NodePath.join(jobDir(root, id), "ci-output.txt");

export type CiStepsOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "wait" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "fail"; readonly reason: string; readonly failed?: FailedStep | undefined };

/** A declared step; one with a `hook` runs that git hook, on this host only. */
export interface CiStep extends RemoteStep {
  readonly hook?: StepHook | undefined;
}

export interface FailedStep {
  readonly name: string;
  readonly res: ProcessResult;
}

export function combinedOutput(res: ProcessResult): string {
  return `${res.stdout}${res.stderr}`.trimEnd();
}

/** CI hosts other open jobs hold right now, for routing's settle window. */
function activeLeases(root: string, selfId: string): ReadonlyArray<ActiveRouteLease> {
  return listJobIds(root, { open: true }).flatMap((id) => {
    const job = id === selfId ? null : readJob(root, id);
    if (!job?.ci_lease || isEnded(job)) return [];
    const at = Date.parse(job.ci_lease.routed_at);
    if (!Number.isFinite(at)) return [];
    return [
      { jobId: id, host: job.ci_lease.host, routedAtSec: Math.floor(at / 1000), ciDone: false },
    ];
  });
}

/** Declared CI secrets this worker holds in its own environment; the rest are said, never invented. */
function declaredSecrets(decl: ShipDeclaration, log: (text: string) => void) {
  const out: Record<string, string> = {};
  for (const name of decl.ciSecrets) {
    const value = name === "DOPPLER_TOKEN" ? undefined : process.env[name];
    if (value && !/[\r\n\0]/.test(value)) out[name] = value;
    else
      log(
        `UNPROVEN: ci secret ${name}: not in this worker's environment, not sent; the CI runs without it`,
      );
  }
  return out;
}

/** Declaration keys this runner does not provide yet, said once per run instead of dropped. */
function logUnsupported(decl: ShipDeclaration, log: (text: string) => void): void {
  const unsupported: Array<[string, ReadonlyArray<string>]> = [
    ["ship_ci_doppler", decl.ciDoppler],
    ["ship_ci_evidence", decl.ciEvidence],
  ];
  for (const [key, values] of unsupported) {
    if (values.length > 0) {
      log(
        `UNPROVEN: ${key} (${values.join(", ")}): this queue does not provide it yet; the CI runs without it`,
      );
    }
  }
}

/** The stage header a services failure prints (the legacy queue's `ci-services` stage). */
const CI_SERVICES_HEADER = "=== ci-services: the services the job's CI starts on its CI host ===";

/**
 * Runs `body` on this host with the job's services up, and stops them after it whatever happens
 * (a failed step, a cancel, a throw). Returns why the services did not start, or null.
 */
async function runLocalSteps(
  services: CiServicePlan | null,
  worktree: string,
  deps: ShipQueueDeps,
  log: (text: string) => void,
  body: (stepCtx: { readonly ciServiceEnv?: Readonly<Record<string, string>> }) => Promise<void>,
): Promise<string | null> {
  if (!services) {
    await body({});
    return null;
  }
  const shell = localServiceShell(deps.run, worktree);
  try {
    const started = await startCiServices(shell, services, log);
    if (started.kind !== "up") return started.reason;
    await body({ ciServiceEnv: started.env });
    return null;
  } finally {
    await stopCiServices(shell, services, log);
  }
}

/** A step's run with a log line every minute, so a watch never reads a long CI as QUIET. */
async function withHeartbeat<T>(
  log: (text: string) => void,
  label: string,
  run: Promise<T>,
): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => {
    log(`${label} still running (${Math.round((Date.now() - started) / 1000)}s)`);
  }, HEARTBEAT_MS);
  try {
    return await run;
  } finally {
    clearInterval(timer);
  }
}

async function placeCi(
  deps: ShipQueueDeps,
  job: JobRecord,
  decl: ShipDeclaration,
  remoteAllowed: boolean,
  tip: string | undefined,
  services: ReadonlyArray<string>,
): Promise<CiPlacement | null> {
  const fallback: CiPlacement = {
    kind: "local",
    host: "local",
    dataRoot: process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "",
    note: "",
  };
  if (!remoteAllowed || !deps.ciPlacer) return fallback;
  const lastTry = job.ci_wait && job.ci_wait.tip === tip ? Date.parse(job.ci_wait.at) : Number.NaN;
  if (Number.isFinite(lastTry) && Date.parse(deps.clock.now()) - lastTry < CI_WAIT_RETRY_MS) {
    return null;
  }
  return deps.ciPlacer({
    jobId: job.id,
    decl,
    services,
    activeLeases: activeLeases(deps.root, job.id),
  });
}

/**
 * Runs `steps` (install, CI, a merge gate) where routing says, falling back to this host when a
 * remote host fails before a step's own result. `remoteAllowed` is false for steps that must run
 * here (a pre-push hook and the install it judges). The output lands in `outputFile`
 * (`ci-output.txt`, for the challenge, by default), after what is there when `appendOutput`.
 */
export async function runCiSteps(input: {
  readonly deps: ShipQueueDeps;
  readonly job: JobRecord;
  readonly decl: ShipDeclaration;
  readonly ctx: StepJobContext;
  readonly steps: ReadonlyArray<CiStep>;
  readonly remoteAllowed: boolean;
  readonly timings: StepTiming[];
  readonly outputFile?: string | undefined;
  readonly appendOutput?: boolean | undefined;
}): Promise<CiStepsOutcome> {
  const { deps, job, decl, steps, timings } = input;
  const log = (text: string) => appendLog(deps.root, job.id, text);
  // The services the job starts decide routing too: a host without docker never takes it.
  const planned = await planCiServices({
    run: deps.run,
    worktree: input.ctx.worktree,
    tip: input.ctx.tipSha ?? "HEAD",
    repo: decl.repo || input.ctx.ghRepo?.split("/").at(-1) || input.ctx.repo,
    jobId: job.id,
    decl,
  });
  if (!planned.ok) {
    log(`${CI_SERVICES_HEADER}\n  ${planned.reason}; the CI did not run`);
    return { kind: "fail", reason: `ci_services ${planned.reason}` };
  }
  const services = planned.plan;
  const placement = await placeCi(
    deps,
    job,
    decl,
    input.remoteAllowed,
    input.ctx.tipSha,
    services ? plannedServiceNames(services) : [],
  );
  if (!placement) return { kind: "wait" };
  if (placement.kind === "fail") return { kind: "fail", reason: placement.reason };
  if (placement.kind === "wait") {
    const now = deps.clock.now();
    const since = job.ci_wait?.since ?? now;
    if (Date.parse(now) - Date.parse(since) >= CI_WAIT_LIMIT_MS) {
      return { kind: "fail", reason: `ci_host_unavailable ${placement.reason}` };
    }
    log(
      `waiting for a CI host: ${placement.reason}; routing asks again in ${CI_WAIT_RETRY_MS / 1000}s`,
    );
    updateJob(deps.root, job.id, {
      ci_wait: { reason: placement.reason, at: now, since, tip: input.ctx.tipSha },
    });
    return { kind: "wait" };
  }
  const placed =
    placement.kind === "local" && placement.dataRoot
      ? { ...input.ctx, dataRoot: placement.dataRoot }
      : input.ctx;
  const ctx = decl.ciEnv ? { ...placed, ciEnvFile: decl.ciEnv } : placed;
  if (placement.note) log(placement.note);
  logUnsupported(decl, log);
  const secrets = declaredSecrets(decl, log);
  const host = placement.kind === "remote" ? placement.host.name : placement.host;
  updateJob(deps.root, job.id, {
    ci_wait: undefined,
    ci_lease: { host, routed_at: new Date().toISOString() },
  });

  const outputs: string[] = [];
  let failed: FailedStep | null = null;
  const record = (name: string, at: string, res: ProcessResult, ms: number): boolean => {
    timings.push({ name, host: at, exit: res.exitCode, ms });
    updateJob(deps.root, job.id, { steps: [...timings] });
    mark(deps.root, job.id, `STEP name=${name} host=${at} exit=${res.exitCode} ms=${ms}`);
    outputs.push(
      `=== ${name} (host ${at}, exit ${res.exitCode}, ${(ms / 1000).toFixed(1)}s) ===\n${combinedOutput(res)}\n`,
    );
    if (res.exitCode !== 0) failed = { name, res };
    return res.exitCode === 0;
  };
  const cancelled = () => cancelRequested(deps.root, job.id);

  try {
    let ranRemote = false;
    if (placement.kind === "remote" && placement.host.ssh && !steps.some((s) => s.hook)) {
      const remoteHost = placement.host.name;
      const remote = await withHeartbeat(
        log,
        `CI on ${remoteHost}`,
        runRemoteCi({
          host: { ...placement.host, ssh: placement.host.ssh },
          decl,
          ctx: { ...ctx, ontoSha: ctx.ontoSha ?? ctx.baseSha, tipSha: ctx.tipSha ?? "" },
          body: NodeFS.readFileSync(jobBodyPath(deps.root, job.id), "utf8"),
          steps,
          secrets,
          services,
          run: deps.run,
          runRemote: deps.runRemote,
          log,
          nowMs: () => Date.now(),
          onStep: (step, res, ms) => record(step.name, remoteHost, res, ms) && !cancelled(),
        }),
      );
      if (remote.kind === "refused") {
        log(`${CI_SERVICES_HEADER}\n  ${remote.detail}; the CI did not run`);
        return { kind: "fail", reason: `ci_services ${remote.detail}` };
      }
      if (remote.kind === "infra") {
        log(`CI host ${remoteHost} unavailable (${remote.detail}); CI runs on this host`);
      } else {
        ranRemote = true;
      }
    }
    if (!ranRemote) {
      const local = await runLocalSteps(services, ctx.worktree, deps, log, async (stepCtx) => {
        for (const step of steps) {
          if (cancelled()) break;
          const started = Date.now();
          const res = await withHeartbeat(
            log,
            step.name,
            runLocalStep({
              mode: "ci",
              ctx: { ...ctx, ...stepCtx },
              cmdline: step.cmdline,
              secrets,
              withholdSecrets: step.withholdSecrets,
              hook: step.hook,
              timeoutMs: step.timeoutMs,
              run: deps.run,
            }),
          );
          if (!record(step.name, "local", res, Date.now() - started)) break;
        }
      });
      if (local) {
        log(`${CI_SERVICES_HEADER}\n  ${local}; the CI did not run`);
        return { kind: "fail", reason: `ci_services ${local}` };
      }
    }
    const outputFile = input.outputFile ?? ciOutputPath(deps.root, job.id);
    if (input.appendOutput) NodeFS.appendFileSync(outputFile, outputs.join("\n"), "utf8");
    else NodeFS.writeFileSync(outputFile, outputs.join("\n"), "utf8");
    const failure = failed as FailedStep | null;
    if (failure) {
      return {
        kind: "fail",
        reason: `ci step=${failure.name} exit=${failure.res.exitCode}`,
        failed: failure,
      };
    }
    return cancelled() ? { kind: "cancelled" } : { kind: "pass" };
  } finally {
    if (readJob(deps.root, job.id)?.ci_lease) updateJob(deps.root, job.id, { ci_lease: undefined });
  }
}
