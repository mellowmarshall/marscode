// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Headless `playbook` CLI for CI hosts and agent sessions (no apps/server imports).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { requestGuardGrant } from "@t3tools/guard-protocol/client";

import { planAmend, proposeAmendText } from "./amend.ts";
import { installedExceptionsPath, readExceptionsFile, repoBypasses } from "./bypass.ts";
import { decodeChallengeReplyText } from "./challengeReply.ts";
import { createCliChallengeModel } from "./challengeRunner.ts";
import { runChallenge, type ChallengeModel } from "./challenger.ts";
import { ALL_GATE_NAMES, runCheck, type OverrideAsk } from "./checks.ts";
import { ciFiles } from "./ciFiles.ts";
import { choiceError, SUBCOMMAND_USAGE, USAGE } from "./cliUsage.ts";
import {
  DECLARATION,
  HOST_VERSION,
  renderDeclaration,
  validateDeclaration,
} from "./declaration.ts";
import { cmdMinimal, MINIMAL_DECLARATION } from "./declarationMinimal.ts";
import { cmdDbDict } from "./dictionaryLookup.ts";
import { cmdIntentAudit, cmdIntentDiff } from "./intentCommands.ts";
import { gateBase, repoName, repoRoot } from "./git.ts";
import { EXIT_FAIL, EXIT_USAGE, renderResult } from "./result.ts";
import { aggregateReviewStats, sortRecordsNewestFirst } from "./statsAggregate.ts";
import {
  collectReviewRecords,
  defaultPlaybookStateDir,
  defaultReviewStatsJsonlPath,
  defaultShipJobsDir,
} from "./statsStore.ts";
import { formatStatsTable } from "./statsTable.ts";
import type { ReviewStatsGroupBy, ReviewStatsSide } from "./statsTypes.ts";

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function wantsHelp(args: ReadonlyArray<string>): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

const today = () => new Date().toISOString().slice(0, 10);

function overrideAsk(root: string, command: ReadonlyArray<string>, io: CliIo): OverrideAsk {
  return async (reason) => {
    const reply = await requestGuardGrant({
      guard: "playbook",
      command,
      cwd: root,
      refusal: reason,
      env: io.env,
    });
    return reply.ok;
  };
}

function bypassesFor(root: string, io: CliIo) {
  return repoBypasses(readExceptionsFile(installedExceptionsPath(io.env)), repoName(root));
}

function readOptional(path: string | undefined): string | null {
  if (!path) return null;
  return NodeFS.readFileSync(path, "utf8");
}

const NO_JOB_CI_OUTPUT =
  "(no CI output: this ship-queue job ran no CI before the review, so judge the diff alone)";

/** ship-queue writes `ci-output.txt` beside the job body after its declared CI; a repo with no CI has none. */
function jobCiOutput(bodyFile: string | undefined): string | null {
  if (!bodyFile) return null;
  try {
    return NodeFS.readFileSync(NodePath.join(NodePath.dirname(bodyFile), "ci-output.txt"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return NO_JOB_CI_OUTPUT;
    throw cause;
  }
}

/** Accepted for compatibility with the original CLI: every declared contract is always validated. */
const TRIGGERS = ["every", "paths", "full"];

function isFile(path: string): boolean {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

async function cmdCheck(root: string, args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      "pr-body": { type: "string" },
      ship: { type: "boolean" },
      trigger: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const badTrigger = choiceError("check", "--trigger", values.trigger, TRIGGERS);
  if (badTrigger) {
    io.err(badTrigger);
    return EXIT_USAGE;
  }
  const prBody = values["pr-body"];
  if (prBody !== undefined && !isFile(NodePath.resolve(io.cwd, prBody))) {
    io.err(`playbook: --pr-body ${prBody} is not a file`);
    return EXIT_USAGE;
  }
  const unknown = positionals.filter((c) => !ALL_GATE_NAMES.includes(c));
  if (unknown.length > 0) {
    io.err(
      `playbook: unknown contract ${unknown.join(", ")} (known: ${ALL_GATE_NAMES.join(", ")})`,
    );
    return EXIT_USAGE;
  }
  const report = await runCheck({
    root,
    repo: repoName(root),
    contracts: positionals,
    body: prBody !== undefined ? readOptional(NodePath.resolve(io.cwd, prBody)) : undefined,
    bypasses: bypassesFor(root, io),
    today: today(),
    override: overrideAsk(root, ["playbook", "check", ...positionals], io),
    env: io.env,
  });
  if (values.json) io.out(JSON.stringify(report, null, 2));
  else {
    for (const result of report.results) io.out(renderResult(result));
    for (const line of report.reported) io.out(`REPORTED ${line}`);
  }
  return report.exitCode;
}

function responseModel(path: string): ChallengeModel {
  return async () => {
    const reply = decodeChallengeReplyText(NodeFS.readFileSync(path, "utf8"));
    if (!reply) throw new Error(`${path} holds no valid challenge reply`);
    return { reply, reviewer: { model: "response-file", provider: "file", effort: "" } };
  };
}

async function cmdChallenge(root: string, args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      tip: { type: "string" },
      out: { type: "string" },
      response: { type: "string" },
      advisory: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const advisory =
    values.advisory === true ||
    Boolean(io.env.PLAYBOOK_CHALLENGE_ADVISORY) ||
    Boolean(io.env.SHIP_QUEUE_JOB);
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const outcome = await runChallenge({
    root,
    repo: repoName(root),
    bypasses: bypassesFor(root, io),
    model: values.response ? responseModel(values.response) : createCliChallengeModel(io.env),
    now: new Date().toISOString(),
    stateDir: defaultPlaybookStateDir(io.env),
    base: values.base,
    tip: values.tip,
    ciOutput: jobCiOutput(io.env.SHIP_QUEUE_BODYFILE),
    advisory,
    threadId: io.env.T3CODE_THREAD_ID,
    signal: ac.signal,
    env: io.env,
  })
    .catch((cause: unknown) => {
      io.err(`playbook challenge: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    })
    .finally(() => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    });
  if (!outcome) return EXIT_FAIL;
  if (values.out) NodeFS.writeFileSync(values.out, `${outcome.report}\n`);
  if (values.json) io.out(JSON.stringify({ ...outcome, prompt: undefined }, null, 2));
  else io.out(outcome.report);
  if (outcome.exitCode === 1 && outcome.status === "challenged") {
    const reason = `declaration-challenge: ${outcome.summary}`;
    if (await overrideAsk(root, ["playbook", "challenge"], io)(reason)) {
      io.err(`OVERRIDDEN ${reason}`);
      return 0;
    }
  }
  return outcome.exitCode;
}

async function cmdAmend(root: string, args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { base: { type: "string" }, issue: { type: "string" }, collect: { type: "boolean" } },
  });
  const [file, textFile] = positionals;
  if (!file || positionals.length > 2) {
    io.err("usage: playbook amend <PLAYBOOK.md> [TEXT_FILE] [--base REF] [--collect]");
    return EXIT_USAGE;
  }
  const base = values.base ?? gateBase(root, io.env).sha;
  if (!base) {
    io.err("playbook amend: no base to compare against (pass --base)");
    return EXIT_USAGE;
  }
  if (textFile === undefined) return (await amendWorktree(root, file, base, values, io)).code;
  const proposed = proposeAmendText(root, file, NodePath.resolve(io.cwd, textFile));
  if (!proposed.ok) {
    io.err(`playbook amend: ${proposed.problem}`);
    return EXIT_USAGE;
  }
  // The text is written only once the owner approves it, as the original does.
  const outcome = await amendWorktree(root, file, base, { ...values, text: proposed.text }, io);
  if (!outcome.approved) return outcome.code;
  const problem = proposed.write();
  if (problem !== null) {
    io.err(`FAIL amend: ${problem}`);
    return EXIT_FAIL;
  }
  return outcome.code;
}

/** The amend of FILE as the worktree holds it; `approved`: the owner granted it. */
async function amendWorktree(
  root: string,
  file: string,
  base: string,
  values: {
    readonly issue?: string | undefined;
    readonly collect?: boolean | undefined;
    readonly text?: string | undefined;
  },
  io: CliIo,
): Promise<{ readonly code: number; readonly approved: boolean }> {
  const plan = planAmend({ root, file, base, issue: values.issue, text: values.text });
  if (!plan.ok) {
    for (const problem of plan.problems) io.err(`FAIL amend: ${problem}`);
    return { code: EXIT_FAIL, approved: false };
  }
  if (plan.unchanged) {
    io.out(`PASS amend: ${plan.descriptor.file} is unchanged against the base`);
    return { code: 0, approved: false };
  }
  if (values.collect) {
    io.out(JSON.stringify(plan.descriptor, null, 2));
    return { code: 0, approved: false };
  }
  const reply = await requestGuardGrant({
    guard: "playbook",
    command: plan.descriptor.command,
    cwd: root,
    refusal: plan.descriptor.refusal,
    bundle: plan.descriptor.bundle,
    env: io.env,
  });
  if (reply.ok) {
    io.out(`PASS amend: ${plan.descriptor.file} approved by the owner`);
    return { code: 0, approved: true };
  }
  io.err(`FAIL amend: the owner's override was not granted (${reply.error ?? "denied"})`);
  return { code: EXIT_FAIL, approved: false };
}

function cmdInit(root: string, args: ReadonlyArray<string>, io: CliIo): number {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: { "dry-run": { type: "boolean" } },
  });
  const path = NodePath.join(root, DECLARATION);
  const errors = validateDeclaration(MINIMAL_DECLARATION);
  if (errors.length > 0) {
    io.err(`playbook init: the minimal declaration is invalid: ${errors.join("; ")}`);
    return EXIT_FAIL;
  }
  const text = renderDeclaration(MINIMAL_DECLARATION);
  if (values["dry-run"]) {
    io.out(text);
    return 0;
  }
  try {
    NodeFS.writeFileSync(path, text, { flag: "wx", mode: 0o644 });
  } catch {
    io.err(`playbook init: ${DECLARATION} already exists; nothing written`);
    return EXIT_FAIL;
  }
  io.out(`wrote ${DECLARATION}`);
  return 0;
}

const STATS_CHOICES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["side", ["reviewer", "submitter", "pair"]],
  ["by", ["model", "family", "lab", "provider", "repo", "source", "effort", "day"]],
  ["source", ["all", "playbook_challenge", "ship_queue_review"]],
];

function cmdStats(args: ReadonlyArray<string>, io: CliIo): number {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      side: { type: "string" },
      by: { type: "string" },
      source: { type: "string" },
      repo: { type: "string" },
      lab: { type: "string" },
      days: { type: "string" },
      "include-bypasses": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  for (const [flag, choices] of STATS_CHOICES) {
    const problem = choiceError("stats", `--${flag}`, values[flag as "side"], choices);
    if (problem) {
      io.err(problem);
      return EXIT_USAGE;
    }
  }
  if (values.days !== undefined && !/^\s*[-+]?\d+\s*$/.test(values.days)) {
    io.err(`playbook stats: error: argument --days: invalid int value: '${values.days}'`);
    return EXIT_USAGE;
  }
  const stats = aggregateReviewStats(
    sortRecordsNewestFirst(
      collectReviewRecords({
        playbookStateDir: defaultPlaybookStateDir(io.env),
        shipJobsDir: defaultShipJobsDir(io.env),
        jsonlPath: defaultReviewStatsJsonlPath(io.env),
      }),
    ),
    {
      side: (values.side as ReviewStatsSide | undefined) ?? "reviewer",
      by: (values.by as ReviewStatsGroupBy | undefined) ?? "model",
      source:
        (values.source as "all" | "playbook_challenge" | "ship_queue_review" | undefined) ?? "all",
      repo: values.repo,
      lab: values.lab,
      days: values.days !== undefined && Number(values.days) > 0 ? Number(values.days) : undefined,
      includeBypasses: values["include-bypasses"] === true,
      nowMs: Date.now(),
      localHostName: NodeOS.hostname(),
    },
  );
  io.out(values.json ? JSON.stringify(stats, null, 2) : formatStatsTable(stats));
  return 0;
}

function cmdCiFiles(root: string, args: ReadonlyArray<string>, io: CliIo): number {
  const { values } = NodeUtil.parseArgs({ args: [...args], options: { rev: { type: "string" } } });
  io.out(ciFiles(root, values.rev ?? "HEAD").join("\n"));
  return 0;
}

/** `-C DIR` or `-CDIR` before the command: (the directory, the rest). */
function takeDir(argv: ReadonlyArray<string>, cwd: string): { dir: string; args: string[] } {
  const args = [...argv];
  const first = args[0] ?? "";
  if (first === "-C") {
    const dir = NodePath.resolve(cwd, args[1] ?? ".");
    return { dir, args: args.slice(2) };
  }
  if (first.startsWith("-C"))
    return { dir: NodePath.resolve(cwd, first.slice(2)), args: args.slice(1) };
  return { dir: cwd, args };
}

export async function runPlaybookCli(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { dir, args } = takeDir(argv, io.cwd);
  const [cmd, ...rest] = args;
  if (!cmd) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return 0;
  }
  const subUsage = SUBCOMMAND_USAGE[cmd];
  if (subUsage && wantsHelp(rest)) {
    io.out(subUsage);
    return 0;
  }
  try {
    if (cmd === "version") {
      io.out(`playbook ${HOST_VERSION}`);
      return 0;
    }
    if (cmd === "stats") return cmdStats(rest, io);
    if (cmd === "minimal") {
      const { values } = NodeUtil.parseArgs({
        args: rest,
        options: { merge: { type: "string" } },
      });
      return cmdMinimal(values.merge, io);
    }
    if (!NodeFS.existsSync(dir) || !NodeFS.statSync(dir).isDirectory()) {
      io.err(`playbook: ${dir} is not a directory`);
      return EXIT_USAGE;
    }
    const root = repoRoot(dir);
    if (cmd === "check") return await cmdCheck(root, rest, io);
    if (cmd === "challenge") return await cmdChallenge(root, rest, io);
    if (cmd === "amend") return await cmdAmend(root, rest, io);
    if (cmd === "init") return cmdInit(root, rest, io);
    if (cmd === "db-dict") return cmdDbDict(root, rest, io);
    if (cmd === "intent-diff") return cmdIntentDiff(root, rest, io);
    if (cmd === "intent-audit") return cmdIntentAudit(root, rest, io);
    if (cmd === "ci-files") return cmdCiFiles(root, rest, io);
  } catch (cause) {
    io.err(`playbook ${cmd}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_USAGE;
  }
  io.err(`playbook: unknown command ${cmd}\n${USAGE}`);
  return EXIT_USAGE;
}
