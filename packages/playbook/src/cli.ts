// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Headless `playbook` CLI for CI hosts and agent sessions (no apps/server imports).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { requestGuardGrant } from "@t3tools/guard-protocol/client";

import { planAmend } from "./amend.ts";
import { installedExceptionsPath, readExceptionsFile, repoBypasses } from "./bypass.ts";
import { decodeChallengeReplyText } from "./challengeReply.ts";
import { runChallenge, type ChallengeModel } from "./challenger.ts";
import { runCheck, type OverrideAsk } from "./checks.ts";
import {
  CONTRACT_NAMES,
  DECLARATION,
  HOST_VERSION,
  renderDeclaration,
  validateDeclaration,
} from "./declaration.ts";
import { gateBase, repoName, repoRoot } from "./git.ts";
import { EXIT_FAIL, EXIT_USAGE, renderResult } from "./result.ts";
import { aggregateReviewStats, sortRecordsNewestFirst } from "./statsAggregate.ts";
import {
  collectReviewRecords,
  defaultPlaybookStateDir,
  defaultReviewStatsJsonlPath,
  defaultShipJobsDir,
} from "./statsStore.ts";
import type { ReviewStatsGroupBy, ReviewStatsSide } from "./statsTypes.ts";

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const USAGE = `usage: playbook [-C DIR] <command>
  check [contract...] [--pr-body FILE] [--json]   run the declared contracts' gates
  challenge [--base REF] [--tip REF] [--response FILE] [--out FILE] [--advisory] [--json]
                                                  the declaration challenge on the real worktree
  amend <PLAYBOOK.md|CHALLENGE.md> [--base REF] [--issue #N] [--collect]
                                                  amend the standards under the owner's override
  init [--dry-run]                                write the minimal playbook.json
  stats [--side S] [--by G] [--source S] [--repo R] [--days N] [--json]
                                                  review verdict statistics
  version                                         print the host playbook version`;

/** The minimal valid declaration: every repo's required contracts, each with its nothing-here value. */
const MINIMAL_DECLARATION = {
  contracts: {
    size: { command: "echo '{}'" },
    fleet: { file: "fleet.json", reads: "echo '{}'" },
    tools: { steps: [] },
    generations: { command: null },
    optimization: { none: "nothing to budget: no route, job or action" },
  },
} as const;

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

async function cmdCheck(root: string, args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { "pr-body": { type: "string" }, json: { type: "boolean" } },
  });
  const unknown = positionals.filter((c) => !(CONTRACT_NAMES as ReadonlyArray<string>).includes(c));
  if (unknown.length > 0) {
    io.err(
      `playbook: unknown contract ${unknown.join(", ")} (known: ${CONTRACT_NAMES.join(", ")})`,
    );
    return EXIT_USAGE;
  }
  const report = await runCheck({
    root,
    repo: repoName(root),
    contracts: positionals,
    body: values["pr-body"] ? readOptional(values["pr-body"]) : undefined,
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
  const outcome = await runChallenge({
    root,
    repo: repoName(root),
    bypasses: bypassesFor(root, io),
    model: values.response ? responseModel(values.response) : null,
    now: new Date().toISOString(),
    stateDir: defaultPlaybookStateDir(io.env),
    base: values.base,
    tip: values.tip,
    ciOutput: readOptional(
      io.env.SHIP_QUEUE_BODYFILE
        ? NodePath.join(NodePath.dirname(io.env.SHIP_QUEUE_BODYFILE), "ci-output.txt")
        : undefined,
    ),
    advisory,
    threadId: io.env.T3CODE_THREAD_ID,
    env: io.env,
  }).catch((cause: unknown) => {
    io.err(`playbook challenge: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
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
  const file = positionals[0];
  if (!file || positionals.length > 1) {
    io.err("usage: playbook amend <PLAYBOOK.md|CHALLENGE.md> [--base REF] [--collect]");
    return EXIT_USAGE;
  }
  const base = values.base ?? gateBase(root, io.env).sha;
  if (!base) {
    io.err("playbook amend: no base to compare against (pass --base)");
    return EXIT_USAGE;
  }
  const plan = planAmend({ root, file, base, issue: values.issue });
  if (!plan.ok) {
    for (const problem of plan.problems) io.err(`FAIL amend: ${problem}`);
    return EXIT_FAIL;
  }
  if (plan.unchanged) {
    io.out(`PASS amend: ${plan.descriptor.file} is unchanged against the base`);
    return 0;
  }
  if (values.collect) {
    io.out(JSON.stringify(plan.descriptor, null, 2));
    return 0;
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
    return 0;
  }
  io.err(`FAIL amend: the owner's override was not granted (${reply.error ?? "denied"})`);
  return EXIT_FAIL;
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

function cmdStats(args: ReadonlyArray<string>, io: CliIo): number {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      side: { type: "string" },
      by: { type: "string" },
      source: { type: "string" },
      repo: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const source = values.source;
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
      source: source === "playbook_challenge" || source === "ship_queue_review" ? source : "all",
      repo: values.repo,
      days: values.days ? Number(values.days) : undefined,
      nowMs: Date.now(),
      localHostName: NodeOS.hostname(),
    },
  );
  if (values.json) {
    io.out(JSON.stringify(stats, null, 2));
    return 0;
  }
  io.out(`${stats.totals.reviews} review(s), ${stats.totals.passRatePct}% passed`);
  for (const g of stats.groups) {
    io.out(`  ${g.key}: ${g.reviews} review(s), ${g.flagged} flagged, ${g.total} issue(s)`);
  }
  return 0;
}

export async function runPlaybookCli(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const args = [...argv];
  let dir = io.cwd;
  if (args[0] === "-C") {
    dir = NodePath.resolve(io.cwd, args[1] ?? ".");
    args.splice(0, 2);
  }
  const [cmd, ...rest] = args;
  if (cmd === "version") {
    io.out(`playbook ${HOST_VERSION}`);
    return 0;
  }
  if (cmd === "stats") return cmdStats(rest, io);
  if (!cmd || cmd === "help" || cmd === "--help") {
    io.out(USAGE);
    return cmd ? 0 : EXIT_USAGE;
  }
  if (!NodeFS.existsSync(dir) || !NodeFS.statSync(dir).isDirectory()) {
    io.err(`playbook: ${dir} is not a directory`);
    return EXIT_USAGE;
  }
  const root = repoRoot(dir);
  try {
    if (cmd === "check") return await cmdCheck(root, rest, io);
    if (cmd === "challenge") return await cmdChallenge(root, rest, io);
    if (cmd === "amend") return await cmdAmend(root, rest, io);
    if (cmd === "init") return cmdInit(root, rest, io);
  } catch (cause) {
    io.err(`playbook ${cmd}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_USAGE;
  }
  io.err(`playbook: unknown command ${cmd}\n${USAGE}`);
  return EXIT_USAGE;
}
