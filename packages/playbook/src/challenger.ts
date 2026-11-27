// @effect-diagnostics nodeBuiltinImport:off - Writes challenge records to the playbook state dir and reads PLAYBOOK.md.
/**
 * `playbook challenge`: judge one change against PLAYBOOK.md, read from the REAL worktree's
 * git objects with the checkout as the reviewer's cwd. No snapshot or temp clone, so dangling
 * symlinks and untracked files never break a review. The model call is the caller's.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { bypassReason, type Bypasses } from "./bypass.ts";
import {
  judgeChallengeReply,
  NO_RISES,
  renderChallengeReport,
  RISE_REFUSED,
  type ChallengeMeta,
  type ChallengeVerdict,
  type PlaybookChallengeReply,
} from "./challengeReply.ts";
import {
  playbookStandards,
  readChallengeTemplate,
  readPlaybookStandards,
  renderChallengePrompt,
} from "./challengePrompt.ts";
import {
  ciAndCheckChanges,
  DECLARATION_PATTERNS,
  declaredRouteFiles,
  formatSurfacesSummary,
  sqlChangedPaths,
} from "./challengeSurfaces.ts";
import {
  changedFiles,
  commitMessages,
  currentBranch,
  diffText,
  gateBase,
  resolveCommit,
} from "./git.ts";

/** The reviewer: given the real checkout and the prompt, its reply (throws when it gives none). */
export type ChallengeModel = (request: {
  readonly cwd: string;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
}) => Promise<{
  readonly reply: PlaybookChallengeReply;
  readonly reviewer: { readonly model: string; readonly provider: string; readonly effort: string };
  readonly fallbackUsed?: boolean | undefined;
}>;

export interface ChallengeOptions {
  readonly root: string;
  readonly repo: string;
  readonly bypasses: Bypasses;
  readonly model: ChallengeModel | null;
  /** ISO timestamp for the record. */
  readonly now: string;
  readonly stateDir: string;
  readonly base?: string | null | undefined;
  readonly tip?: string | undefined;
  readonly body?: string | null | undefined;
  readonly ciOutput?: string | null | undefined;
  readonly rises?: string | undefined;
  readonly standardsPath?: string | undefined;
  readonly templatePath?: string | undefined;
  readonly advisory?: boolean | undefined;
  readonly threadId?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Aborting stops the reviewer's model call. */
  readonly signal?: AbortSignal | undefined;
}

export type ChallengeStatus =
  | "pass"
  | "challenged"
  | "rejected_budget"
  | "no_verdict"
  | "no_changes"
  | "bypassed";

export interface ChallengeOutcome {
  readonly status: ChallengeStatus;
  readonly exitCode: number;
  readonly summary: string;
  readonly report: string;
  readonly verdict: ChallengeVerdict | null;
  readonly recordPath: string | null;
  readonly prompt: string | null;
}

const cap = (text: string, n: number, what: string) =>
  text.length > n ? `${text.slice(0, n)}\n... (${what} truncated at ${n / 1000}k chars)` : text;

function noVerdict(summary: string, advisory: boolean, rises: string): ChallengeOutcome {
  const code = advisory ? 0 : rises !== NO_RISES ? RISE_REFUSED : 1;
  return {
    status: "no_verdict",
    exitCode: code,
    summary: `${summary} (no verdict)`,
    report: `FAIL declaration-challenge: ${summary}`,
    verdict: null,
    recordPath: null,
    prompt: null,
  };
}

/** Claim the next free `<branch>.<pass>` pair: the .json is created with `wx`, so no run clobbers another. */
function claimRecordPaths(stateDir: string, repo: string, branch: string) {
  const folder = NodePath.join(stateDir, repo);
  NodeFS.mkdirSync(folder, { recursive: true });
  const slug = branch.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const re = new RegExp(`^${slug.replace(/[.]/g, "\\.")}\\.(\\d+)\\.challenge\\.(?:txt|json)$`);
  const passes = NodeFS.readdirSync(folder).flatMap((f) => {
    const m = re.exec(f);
    return m ? [Number(m[1])] : [];
  });
  for (let pass = (passes.length > 0 ? Math.max(...passes) : 0) + 1; ; pass += 1) {
    const json = NodePath.join(folder, `${slug}.${pass}.challenge.json`);
    try {
      NodeFS.closeSync(NodeFS.openSync(json, "wx", 0o600));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
    return { pass, json, txt: NodePath.join(folder, `${slug}.${pass}.challenge.txt`) };
  }
}

function readBody(options: ChallengeOptions, base: string, tip: string): string {
  if (options.body) return cap(options.body, 32_000, "body");
  const bodyFile = (options.env ?? process.env).SHIP_QUEUE_BODYFILE;
  if (bodyFile) {
    try {
      return cap(NodeFS.readFileSync(bodyFile, "utf8"), 32_000, "body");
    } catch {
      // fall back to the commits
    }
  }
  return cap(commitMessages(options.root, base, tip), 32_000, "body");
}

/** Run the declaration challenge on the real worktree. */
export async function runChallenge(options: ChallengeOptions): Promise<ChallengeOutcome> {
  const { root, repo, bypasses } = options;
  const advisory = options.advisory === true;
  const rises = options.rises ?? NO_RISES;
  const tipRef = options.tip ?? "HEAD";
  const tip = resolveCommit(root, tipRef);
  if (!tip)
    return noVerdict(`tip ${JSON.stringify(tipRef)} does not resolve to a commit`, advisory, rises);
  // No base is no verdict: a change that cannot be compared is never passed.
  const gate = options.base ? null : gateBase(root, options.env);
  const base = options.base ? resolveCommit(root, options.base) : (gate?.sha ?? null);
  if (!base) {
    const why = options.base
      ? `base ${JSON.stringify(options.base)} does not resolve to a commit`
      : `no base commit to compare against (${gate?.problem ?? "unknown"})`;
    return noVerdict(why, advisory, rises);
  }
  const branch = currentBranch(root);
  const meta = (pass: number, reviewer: string): ChallengeMeta => ({
    repo,
    branch,
    pass,
    commit: tip,
    base,
    reviewer,
    timestamp: options.now,
  });
  const write = (
    reply: PlaybookChallengeReply,
    verdict: ChallengeVerdict,
    reviewer: { readonly model: string; readonly provider: string; readonly effort: string },
    extra: Readonly<Record<string, unknown>>,
  ) => {
    const paths = claimRecordPaths(options.stateDir, repo, branch);
    const label = reviewer.effort ? `${reviewer.model} (${reviewer.effort})` : reviewer.model;
    const report = renderChallengeReport(meta(paths.pass, label), reply, verdict, rises);
    const record = {
      ...reply,
      acceptable: verdict.passed,
      rejected_rises: verdict.rejected,
      defects: verdict.defects,
      repo,
      branch,
      pass: paths.pass,
      commit: tip,
      base,
      reviewer: label,
      reviewer_model: reviewer.model,
      reviewer_provider: reviewer.provider,
      reviewer_effort: reviewer.effort,
      worktree: root,
      thread_id: options.threadId ?? "",
      timestamp: options.now,
      ...extra,
    };
    NodeFS.writeFileSync(paths.txt, `${report}\n`);
    NodeFS.writeFileSync(paths.json, JSON.stringify(record, null, 2));
    return { report, recordPath: paths.json };
  };

  const ownerWhy = bypassReason(bypasses, "challenge");
  if (ownerWhy) {
    const reply: PlaybookChallengeReply = {
      acceptable: true,
      summary: `Bypassed by owner (${ownerWhy})`,
      diagnosis: "The declaration challenge is bypassed for this repository.",
      bypass_detected: false,
      playbook_friction: false,
      rejected_rises: [],
      rises_accepted: true,
      defects: [],
      analysis: "",
      recommendation: "Accept.",
    };
    const verdict = judgeChallengeReply(reply, NO_RISES);
    const owner = { model: "owner-bypass", provider: "bypass", effort: "" };
    const { report, recordPath } = write(reply, verdict, owner, {});
    return {
      status: "bypassed",
      exitCode: 0,
      summary: reply.summary,
      report,
      verdict,
      recordPath,
      prompt: null,
    };
  }

  const changed = changedFiles(root, base, tip);
  if (changed === null)
    return noVerdict(`git diff failed against ${base.slice(0, 12)}`, advisory, rises);
  if (changed.length === 0 && rises === NO_RISES) {
    const summary = `no changes against ${base.slice(0, 12)}`;
    return {
      status: "no_changes",
      exitCode: 0,
      summary,
      report: `PASS declaration-challenge: ${summary}`,
      verdict: null,
      recordPath: null,
      prompt: null,
    };
  }
  const sqlPaths = sqlChangedPaths(root, base, tip, changed);
  const standardsSource = readPlaybookStandards(root, {
    explicit: options.standardsPath,
    baseRef: base,
  });
  if (!standardsSource) return noVerdict("no PLAYBOOK.md to review against", advisory, rises);
  let prompt: string;
  try {
    const standards = playbookStandards(standardsSource.text, bypasses);
    const templateFile = options.templatePath ?? null;
    const ciOutput = (options.ciOutput ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
    prompt = renderChallengePrompt(readChallengeTemplate(templateFile), {
      playbook: standards,
      base: base.slice(0, 12),
      tip: tip.slice(0, 12),
      surfaces: formatSurfacesSummary(changed, declaredRouteFiles(root, [base, tip]), sqlPaths),
      rises,
      diff: cap(
        diffText(root, base, tip, DECLARATION_PATTERNS).trim() || "(no declaration files modified)",
        32_000,
        "diff",
      ),
      ci_checks: ciAndCheckChanges(root, base, tip, changed),
      body: readBody(options, base, tip),
      ci_output:
        ciOutput.length > 16_000
          ? `${ciOutput.slice(0, 4_000)}\n... (middle truncated) ...\n${ciOutput.slice(-12_000)}`
          : ciOutput || "(no CI output provided)",
    });
  } catch (cause) {
    return noVerdict(cause instanceof Error ? cause.message : String(cause), advisory, rises);
  }
  if (!options.model)
    return { ...noVerdict("no reviewer model is configured", advisory, rises), prompt };
  let answer: Awaited<ReturnType<ChallengeModel>>;
  const startedMs = performance.now();
  try {
    answer = await options.model({ cwd: root, prompt, signal: options.signal });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return { ...noVerdict(`the reviewer gave no answer: ${why}`, advisory, rises), prompt };
  }
  const durationS = Math.round((performance.now() - startedMs) / 100) / 10;
  const verdict = judgeChallengeReply(answer.reply, rises);
  const { report, recordPath } = write(answer.reply, verdict, answer.reviewer, {
    fallback_used: answer.fallbackUsed === true,
    duration_s: durationS,
  });
  const status: ChallengeStatus = verdict.passed
    ? "pass"
    : verdict.rejected.length > 0
      ? "rejected_budget"
      : "challenged";
  const exitCode = verdict.passed || advisory ? 0 : verdict.rejected.length > 0 ? RISE_REFUSED : 1;
  return { status, exitCode, summary: answer.reply.summary, report, verdict, recordPath, prompt };
}
