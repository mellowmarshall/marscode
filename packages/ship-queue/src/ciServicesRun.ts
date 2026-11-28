// Starts and stops a job's CI services with docker compose on the host its CI runs on, local or
// remote, as the legacy queue did: the job's own project, the declared env file sourced, a health
// wait, and `down -v` afterwards whatever the outcome.
import { shellSingleQuote } from "@t3tools/ssh/command";

import {
  composeConfigServices,
  selectStartedServices,
  unpinnedServiceImages,
  type CiServicePlan,
} from "./ciServicesPlan.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import { allowlistedStepBaseEnv, buildRemoteEnvAllowlistScript } from "./stepEnv.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

/** How long compose waits for the started services to be healthy (or running, with no check). */
export const SERVICE_HEALTH_WAIT_S = 300;
/** The bound of each services command: the health wait and a first pull of a pinned image. */
const SERVICE_UP_TIMEOUT_MS = 15 * 60_000;
const SERVICE_CONFIG_TIMEOUT_MS = 2 * 60_000;
const SERVICE_DOWN_TIMEOUT_MS = 3 * 60_000;
/** The env file is missing or failed to load: the job's own tree decides that, on every host. */
const ENV_FILE_EXIT = 4;
/** The host has no docker compose: routing should have kept the job off it. */
const NO_COMPOSE_EXIT = 5;

/** Runs one bash script in the job's worktree on the CI host; never rejects. */
export type ServiceShell = (script: string, timeoutMs: number) => Promise<ProcessResult>;

export type ServiceStart =
  | {
      readonly kind: "up";
      readonly services: ReadonlyArray<string>;
      /** What each step gets: the project and the services it runs. */
      readonly env: Readonly<Record<string, string>>;
    }
  /** The job's own files refuse it (no such service, an unpinned image, a bad env file): no host would start it. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The host could not start them (no engine, a pull, a port another project holds, the health wait). */
  | { readonly kind: "failed"; readonly reason: string };

const q = shellSingleQuote;

/** The compose command the job's project is run with: its own name, the files the queue chose. */
function composeCommand(plan: CiServicePlan): string {
  return ["docker compose -p", q(plan.project), ...plan.composeFiles.map((f) => `-f ${q(f)}`)].join(
    " ",
  );
}

/** The legacy setup's env: `COMPOSE_FILE` unset, then the declared env file sourced, its values exported. */
function envPrelude(plan: CiServicePlan): string {
  const lines = ["unset COMPOSE_FILE COMPOSE_PROJECT_NAME"];
  if (plan.envFile) {
    const f = q(`./${plan.envFile}`);
    lines.push(
      `[ -f ${f} ] || { echo "the declared env file (ship_ci_env ${plan.envFile}) is not in the job's tree" >&2; exit ${ENV_FILE_EXIT}; }`,
      `set -a; . ${f} || { echo "the declared env file (ship_ci_env ${plan.envFile}) failed to load" >&2; exit ${ENV_FILE_EXIT}; }; set +a`,
    );
  }
  return lines.join("\n");
}

/** No daemon needed: compose reads the files, their includes, profiles and the env it is given. */
export function serviceConfigScript(plan: CiServicePlan): string {
  return [
    `docker compose version >/dev/null 2>&1 || { echo "this host has no docker compose" >&2; exit ${NO_COMPOSE_EXIT}; }`,
    envPrelude(plan),
    `${composeCommand(plan)} config --format json`,
  ].join("\n");
}

/**
 * Stops every project this repo left (a cancel, a dead worker; the repo's queue lets one of its
 * jobs run at a time), by name alone from `/`, then starts the job's services and waits for them.
 */
export function serviceUpScript(plan: CiServicePlan, services: ReadonlyArray<string>): string {
  const prefix = plan.projectPrefix;
  const leftovers = `( cd / && docker compose ls -a -q --filter name=${q(prefix)} | grep -x ${q(`${prefix}[0-9][0-9]*`)} | while IFS= read -r p; do env -u COMPOSE_FILE docker compose -p "$p" down -v --remove-orphans --timeout 10 >/dev/null 2>&1 && echo "stopped the leftover services project $p"; done; true )`;
  return [
    envPrelude(plan),
    leftovers,
    `${composeCommand(plan)} up -d --quiet-pull --wait --wait-timeout ${SERVICE_HEALTH_WAIT_S} ${services.map(q).join(" ")} || exit $?`,
    `${composeCommand(plan)} ps --format '{{.Service}} {{.Ports}}'`,
  ].join("\n");
}

/** By the project's name alone, from `/`: no compose file or env of the job keeps it running. */
export function serviceDownScript(plan: CiServicePlan): string {
  return `cd / && env -u COMPOSE_FILE docker compose -p ${q(plan.project)} down -v --remove-orphans --timeout 10`;
}

function tail(res: ProcessResult): string {
  const lines = `${res.stdout}\n${res.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-6).join(" | ") || `exit ${res.exitCode}`;
}

/**
 * Starts the plan's services: checks them against the compose configuration the host reads (with
 * the env file sourced) and their image pins, then `up --wait`. A failed start is stopped again.
 */
export async function startCiServices(
  shell: ServiceShell,
  plan: CiServicePlan,
  log: (text: string) => void,
): Promise<ServiceStart> {
  const config = await shell(serviceConfigScript(plan), SERVICE_CONFIG_TIMEOUT_MS);
  if (config.exitCode !== 0) {
    // The host's own failures (no compose, a lost connection, the bound); any other exit is
    // compose refusing the job's files, which no other host would read differently.
    const hostFault = [NO_COMPOSE_EXIT, 99, 124, 127, 255].includes(config.exitCode);
    const why = hostFault
      ? `the services could not be checked on this host (${tail(config)})`
      : `docker compose cannot read the compose configuration (${tail(config)})`;
    return hostFault ? { kind: "failed", reason: why } : { kind: "refused", reason: why };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.stdout);
  } catch {
    return { kind: "failed", reason: `docker compose config printed no JSON (${tail(config)})` };
  }
  const all = composeConfigServices(parsed);
  const selected = selectStartedServices(plan, new Set(all.keys()));
  if (!selected.ok) return { kind: "refused", reason: selected.reason };
  const unpinned = unpinnedServiceImages(all, selected.services);
  if (unpinned.length > 0) {
    return {
      kind: "refused",
      reason: `the CI never pulls an unpinned image: pin a tag other than latest, or a digest, for ${unpinned.join(", ")}`,
    };
  }
  const added = plan.added.length > 0 ? ` (${plan.added.join(" ")} added by the branch)` : "";
  log(
    `starting the declared services (compose project ${plan.project}, ${plan.composeFiles.join(" ")}): ${selected.services.join(" ")}${added}`,
  );
  const up = await shell(serviceUpScript(plan, selected.services), SERVICE_UP_TIMEOUT_MS);
  if (up.exitCode !== 0) {
    await stopCiServices(shell, plan, log);
    return {
      kind: up.exitCode === ENV_FILE_EXIT ? "refused" : "failed",
      reason: `the declared services (${selected.services.join(" ")}) did not start healthy within ${SERVICE_HEALTH_WAIT_S}s: ${tail(up)}`,
    };
  }
  for (const line of up.stdout.split("\n").filter((l) => l.trim()))
    log(`  services: ${line.trim()}`);
  return {
    kind: "up",
    services: selected.services,
    env: {
      SHIP_QUEUE_CI_SERVICES: selected.services.join(" "),
      SHIP_QUEUE_CI_COMPOSE_PROJECT: plan.project,
    },
  };
}

/** Stops the job's project and removes its volumes; a failure is logged, never thrown. */
export async function stopCiServices(
  shell: ServiceShell,
  plan: CiServicePlan,
  log: (text: string) => void,
): Promise<void> {
  const res = await shell(serviceDownScript(plan), SERVICE_DOWN_TIMEOUT_MS).catch(
    (err: unknown): ProcessResult => ({ exitCode: 1, stdout: "", stderr: String(err) }),
  );
  if (res.exitCode !== 0) log(`could not stop compose project ${plan.project}: ${tail(res)}`);
  else log(`stopped the services (compose project ${plan.project})`);
}

/** The services shell on this host: the step allowlist's env plus the docker CLI's own names. */
export function localServiceShell(
  run: ProcessRunner,
  worktree: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): ServiceShell {
  const env = allowlistedStepBaseEnv(baseEnv, { docker: true });
  return (script, timeoutMs) =>
    run({
      command: "bash",
      args: ["-c", script],
      cwd: worktree,
      env,
      replaceEnv: true,
      timeoutMs,
    }).catch((err: unknown): ProcessResult => ({ exitCode: 127, stdout: "", stderr: String(err) }));
}

/** The services shell on a remote CI host: the same allowlist, the toolchain PATH, the run's worktree. */
export function remoteServiceShell(input: {
  readonly runRemote: RemoteCommandRunner;
  readonly ssh: string;
  readonly toolchainSetup: string;
  readonly worktree: string;
}): ServiceShell {
  const prefix = [
    buildRemoteEnvAllowlistScript({ docker: true }),
    input.toolchainSetup,
    `cd ${q(input.worktree)} || exit 99`,
  ].join("\n");
  return (script, timeoutMs) =>
    input
      .runRemote(input.ssh, `${prefix}\n${script}`, { timeoutMs })
      .catch((err: unknown): ProcessResult => ({ exitCode: 255, stdout: "", stderr: String(err) }));
}
