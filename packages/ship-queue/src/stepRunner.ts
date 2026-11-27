// @effect-diagnostics nodeBuiltinImport:off - Declaration-driven local and remote CI step runner sharing one unified toolchain env.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { shellSingleQuote } from "@t3tools/ssh/command";

import type { ShipDeclaration } from "./declaration.ts";
import { CI_SCRUB_SECRET_VARS, formatSecretStdinPayload } from "./dopplerBroker.ts";
import { sshRemoteCommandRunner, type RemoteCommandRunner } from "./sshExec.ts";
import {
  buildToolchainEnv,
  buildToolchainShellSetup,
  formatDataRootShell,
} from "./toolchainEnv.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

export type StepMode = "plain" | "stage" | "ci";

/** Builtin-only remote secret reader (no single quotes; runs inside remote bash -c). */
const REMOTE_SECRET_READER =
  'unset CLOUDFLARE_API_TOKEN DOPPLER_TOKEN FLY_API_TOKEN FLY_ACCESS_TOKEN HCLOUD_TOKEN NEON_API_KEY OP_SERVICE_ACCOUNT_TOKEN; for l in $(compgen -v DOPPLER_TOKEN_) $(compgen -v DOPPLER_CONFIGS_); do unset "$l"; done; while IFS= read -r l && [ -n "$l" ]; do case "${l%%=*}" in CLOUDFLARE_API_TOKEN|HCLOUD_TOKEN|NEON_API_KEY|OP_SERVICE_ACCOUNT_TOKEN) export "${l%%=*}=${l#*=}" ;; FLY_API_TOKEN) export FLY_API_TOKEN="${l#*=}" FLY_ACCESS_TOKEN="${l#*=}" ;; DOPPLER_TOKEN_*|DOPPLER_CONFIGS_*) case "${l%%=*}" in *[!A-Z0-9_]*) ;; *) export "${l%%=*}=${l#*=}" ;; esac ;; esac; done; unset l';

export interface StepJobContext {
  readonly jobId: string;
  readonly repo: string;
  readonly primary: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly ontoSha?: string | undefined;
  readonly tipSha?: string | undefined;
  readonly ghRepo?: string | undefined;
  readonly queueRoot: string;
  readonly stepTree: string;
  readonly dataRoot: string;
}

export interface LocalStepInput {
  readonly mode: StepMode;
  readonly ctx: StepJobContext;
  readonly cmdline: string;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly cwd?: string | undefined;
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly homeDir?: string | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly withholdSecrets?: boolean | undefined;
  readonly run: ProcessRunner;
}

export interface RemoteStepInput {
  readonly sshAlias: string;
  readonly remoteWorktree: string;
  readonly remoteDataRootDeclared: string;
  readonly ctx: StepJobContext;
  readonly cmdline: string;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly withholdSecrets?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly runRemote?: RemoteCommandRunner | undefined;
}

/** Validates that a declared step command line starts with a safe repo-relative script path. */
export function parseSafeStepCommand(
  cmdline: string,
):
  | { readonly ok: true; readonly script: string; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string } {
  if (/[\r\n\0]/.test(cmdline)) {
    return { ok: false, error: "step command contains control characters" };
  }
  const words = cmdline.trim().split(/\s+/).filter(Boolean);
  const relScript = words[0];
  if (!relScript) {
    return { ok: false, error: "step command is empty" };
  }
  const segments = relScript.split("/");
  if (relScript.startsWith("/") || segments.includes("..") || segments.includes(".")) {
    return { ok: false, error: `step script '${relScript}' is outside the base tree` };
  }
  return { ok: true, script: relScript, args: words.slice(1) };
}

/** Resolves a declared step command line to `[bash, <stepTree>/<script>, ...args]`. */
export function resolveStepArgv(
  stepTree: string,
  cmdline: string,
  extraArgs: ReadonlyArray<string> = [],
):
  | { readonly ok: true; readonly argv: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string } {
  const parsed = parseSafeStepCommand(cmdline);
  if (!parsed.ok) return parsed;
  const scriptPath = NodePath.join(stepTree, parsed.script);
  if (!NodeFS.existsSync(scriptPath) || !NodeFS.statSync(scriptPath).isFile()) {
    return { ok: false, error: `'${parsed.script}' is not in the base tree (${stepTree})` };
  }
  return { ok: true, argv: ["bash", scriptPath, ...parsed.args, ...extraArgs] };
}

/**
 * Builds the environment for local step execution using the ONE unified `buildToolchainEnv`.
 * In `ci` mode, scrubs all ambient secret variables and injects only the declared secrets.
 */
export function buildLocalStepEnv(input: {
  readonly mode: StepMode;
  readonly ctx: StepJobContext;
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly homeDir?: string | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly withholdSecrets?: boolean | undefined;
}): Record<string, string> {
  const env = buildToolchainEnv(input.baseEnv ?? process.env, {
    homeDir: input.homeDir,
    dataRoot: input.ctx.dataRoot,
  });

  env.SHIP_QUEUE_JOB = input.ctx.jobId;
  env.SHIP_QUEUE_REPO = input.ctx.repo;
  env.SHIP_QUEUE_PRIMARY = input.ctx.primary;
  env.SHIP_QUEUE_BASE_REF = input.ctx.baseRef;
  env.SHIP_QUEUE_BASE_SHA = input.ctx.baseSha;
  env.SHIP_QUEUE_BASE_TREE = input.ctx.stepTree;
  env.SHIP_QUEUE_WORKTREE = input.ctx.worktree;
  env.SHIP_QUEUE_BRANCH = input.ctx.branch;
  env.SHIP_QUEUE_STATE = NodePath.join(input.ctx.queueRoot, "repos", input.ctx.repo);
  env.SHIP_QUEUE_REASON_FILE = NodePath.join(
    input.ctx.queueRoot,
    "jobs",
    input.ctx.jobId,
    "work",
    "reason",
  );
  if (input.ctx.ghRepo) env.SHIP_QUEUE_GH_REPO = input.ctx.ghRepo;
  if (input.ctx.ontoSha) env.SHIP_QUEUE_ONTO = input.ctx.ontoSha;
  if (input.ctx.tipSha) env.SHIP_QUEUE_TIP = input.ctx.tipSha;

  if (input.mode === "ci") {
    env.SHIP_QUEUE_CI = "1";
    for (const key of CI_SCRUB_SECRET_VARS) delete env[key];
    for (const key of Object.keys(env)) {
      if (key.startsWith("DOPPLER_TOKEN_") || key.startsWith("DOPPLER_CONFIGS_")) {
        delete env[key];
      }
    }
    if (!input.withholdSecrets && input.secrets) {
      for (const [key, value] of Object.entries(input.secrets)) {
        env[key] = value;
        if (key === "FLY_API_TOKEN") env.FLY_ACCESS_TOKEN = value;
      }
    }
  }
  return env;
}

/** Runs one declared step locally via the injected `ProcessRunner`. */
export async function runLocalStep(input: LocalStepInput): Promise<ProcessResult> {
  const resolved = resolveStepArgv(input.ctx.stepTree, input.cmdline, input.extraArgs);
  if (!resolved.ok) {
    return { exitCode: 1, stdout: "", stderr: `ship-queue: ${resolved.error}\n` };
  }
  const env = buildLocalStepEnv({
    mode: input.mode,
    ctx: input.ctx,
    baseEnv: input.baseEnv,
    homeDir: input.homeDir,
    secrets: input.secrets,
    withholdSecrets: input.withholdSecrets,
  });
  const stateDir = env.SHIP_QUEUE_STATE;
  if (stateDir) NodeFS.mkdirSync(stateDir, { recursive: true });
  const [command, ...args] = resolved.argv;
  return input.run({
    command: command!,
    args,
    cwd: input.cwd ?? input.ctx.worktree,
    env,
  });
}

/**
 * Builds the POSIX bash script for running a CI step on a remote CI host.
 * Uses the exact same `buildToolchainShellSetup` that host probes execute.
 */
export function buildRemoteStepScript(input: {
  readonly remoteWorktree: string;
  readonly remoteDataRootDeclared: string;
  readonly ctx: StepJobContext;
  readonly cmdline: string;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
}): string {
  const dataRootShell = formatDataRootShell(input.remoteDataRootDeclared);
  const setup = buildToolchainShellSetup({ dataRootShell });
  const parsed = parseSafeStepCommand(input.cmdline);
  if (!parsed.ok) {
    throw new Error(`ship-queue: ${parsed.error}`);
  }
  const stepScript = parsed.script;
  const stepArgs = [...parsed.args, ...(input.extraArgs ?? [])].map(shellSingleQuote).join(" ");

  const exports = [
    "FAST=1",
    "SHIP_QUEUE_CI=1",
    "SHIP_QUEUE_REMOTE_CI=0",
    `SHIP_QUEUE_JOB=${shellSingleQuote(input.ctx.jobId)}`,
    `SHIP_QUEUE_REPO=${shellSingleQuote(input.ctx.repo)}`,
    `SHIP_QUEUE_BRANCH=${shellSingleQuote(input.ctx.branch)}`,
    `SHIP_QUEUE_BASE_REF=${shellSingleQuote(input.ctx.baseRef)}`,
    `SHIP_QUEUE_BASE_SHA=${shellSingleQuote(input.ctx.baseSha)}`,
    ...(input.ctx.ontoSha ? [`SHIP_QUEUE_ONTO=${shellSingleQuote(input.ctx.ontoSha)}`] : []),
    ...(input.ctx.tipSha ? [`SHIP_QUEUE_TIP=${shellSingleQuote(input.ctx.tipSha)}`] : []),
  ].join(" ");

  return [
    setup,
    `cd ${shellSingleQuote(input.remoteWorktree)} || exit 99`,
    `sq_g=$(git rev-parse --absolute-git-dir) || exit 99`,
    `export ${exports} DOPPLER_CONFIG_DIR="$sq_g/ship-queue-doppler-config" SHIP_QUEUE_BASE_TREE="$sq_g/ship-queue-base"`,
    `[ ! -f "$sq_g/ship-queue-body.md" ] || export SHIP_QUEUE_BODYFILE="$sq_g/ship-queue-body.md"`,
    REMOTE_SECRET_READER,
    `sq_cmd=(bash "$SHIP_QUEUE_BASE_TREE"/${shellSingleQuote(stepScript)}${stepArgs ? ` ${stepArgs}` : ""})`,
    `if [ "$(uname -s 2>/dev/null)" = Darwin ] && command -v caffeinate >/dev/null 2>&1; then sq_cmd=(caffeinate -i -s "\${sq_cmd[@]}"); fi`,
    `"\${sq_cmd[@]}" <&0`,
  ].join("\n");
}

/** Runs one declared CI step on a remote host via `@t3tools/ssh/command`, piping secrets over stdin. */
export async function runRemoteStep(input: RemoteStepInput): Promise<ProcessResult> {
  const runner = input.runRemote ?? sshRemoteCommandRunner;
  const script = buildRemoteStepScript({
    remoteWorktree: input.remoteWorktree,
    remoteDataRootDeclared: input.remoteDataRootDeclared,
    ctx: input.ctx,
    cmdline: input.cmdline,
    extraArgs: input.extraArgs,
  });
  const stdin = formatSecretStdinPayload(input.secrets ?? {}, input.withholdSecrets);
  return runner(input.sshAlias, script, {
    stdin,
    timeoutMs: input.timeoutMs ?? 60 * 60_000,
  });
}

/** Checks whether a repository declaration withholds CI secrets for a given stage (e.g. recorded merge gate). */
export function shouldWithholdSecretsForStage(
  decl: ShipDeclaration,
  stage: "ci" | "merge" | "deploy",
): boolean {
  return stage === "merge" && decl.passStages.includes("merge");
}
