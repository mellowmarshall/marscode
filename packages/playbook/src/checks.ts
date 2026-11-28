// @effect-diagnostics nodeBuiltinImport:off - Reads the PR body file and validates playbook.json + repo-emitted evidence receipts.
/**
 * `playbook check`: evidence-only declaration, ratchet, contract-intent, and
 * `playbook-evidence/v1` receipt validator. Never executes repo checks itself.
 */
import * as NodeFS from "node:fs";

import { bypassReason, exceptionChanges, EXCEPTIONS_SOURCE, type Bypasses } from "./bypass.ts";
import {
  CONTRACT_NAMES,
  contractsOf,
  contractSettings,
  evidenceDirOf,
  loadDeclaration,
  optedOut,
  parseDeclarationText,
} from "./declaration.ts";
import { validateSectionEvidence } from "./evidence.ts";
import { gateBase, readWorktreeFile, showFile, type GateBase } from "./git.ts";
import { intentGate } from "./intent.ts";
import { judgeIssueBacked, trackedFileScope } from "./exceptionApproval.ts";
import type { IssueLookup } from "./exceptionIssues.ts";
import { declarationRatchet, reportedCommandChanges } from "./ratchet.ts";
import { exitCodeFor, failed, passed, unproven, type CheckResult } from "./result.ts";
import { isRecord } from "./strictJson.ts";

export const ALL_GATE_NAMES: ReadonlyArray<string> = [...CONTRACT_NAMES, "ci"];

/** Asks the owner (the guard broker) to let REASON through; true when granted. */
export type OverrideAsk = (reason: string) => Promise<boolean>;

export interface CheckOptions {
  readonly root: string;
  readonly repo: string;
  readonly contracts?: ReadonlyArray<string> | undefined;
  readonly body?: string | null | undefined;
  readonly bypasses: Bypasses;
  /** YYYY-MM-DD */
  readonly today: string;
  readonly base?: GateBase | undefined;
  readonly override?: OverrideAsk | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Whether an issue is open (default: gh); an issue-backed size exception needs it open. */
  readonly issueState?: IssueLookup | undefined;
  /** Aborting stops the run cleanly. */
  readonly signal?: AbortSignal | undefined;
}

export interface CheckReport {
  readonly repo: string;
  readonly base: string | null;
  readonly results: ReadonlyArray<CheckResult>;
  readonly reported: ReadonlyArray<string>;
  readonly exitCode: number;
}

const noOverride: OverrideAsk = async () => false;

async function held(
  check: string,
  problems: ReadonlyArray<string>,
  okSummary: string,
  ask: OverrideAsk,
  fix: string,
): Promise<CheckResult> {
  if (problems.length === 0) return passed(check, okSummary);
  if (await ask(`${check}: ${problems.join("; ").slice(0, 360)}`)) {
    return passed(check, `${problems.length} loosening(s) under the owner's override`);
  }
  return failed(check, problems[0]!, { errors: problems, fix });
}

function readBody(options: CheckOptions): string | null {
  if (options.body !== undefined) return options.body;
  const path = (options.env ?? process.env).SHIP_QUEUE_BODYFILE;
  if (!path) return null;
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseJsonOrEmpty(text: string | null): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** Validate `playbook.json`, its ratchet, and every declared section's `playbook-evidence/v1` receipt. */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const { root, repo, bypasses } = options;
  const ask = options.override ?? noOverride;
  const decl = loadDeclaration(root);
  if (decl.data === null || decl.errors.length > 0) {
    const results = [failed("declaration", decl.errors[0] ?? "invalid", { errors: decl.errors })];
    return { repo, base: null, results, reported: [], exitCode: exitCodeFor(results) };
  }
  const head = decl.data;
  const evidenceDir = evidenceDirOf(head);
  const base = options.base ?? gateBase(root, options.env);
  const results: CheckResult[] = [passed("declaration", "playbook.json is valid")];
  const baseText = base.sha ? showFile(root, base.sha, "playbook.json") : null;
  const baseParsed = baseText ? parseDeclarationText(baseText, { base: true }) : null;
  const baseData = baseParsed?.data ?? null;
  let reported: ReadonlyArray<string> = [];
  if (!base.sha) {
    results.push(unproven("ratchet", base.problem ?? "no base", { fix: "git fetch origin" }));
  } else if (bypassReason(bypasses, "ratchet")) {
    results.push(passed("ratchet", `bypassed by owner (${bypassReason(bypasses, "ratchet")})`));
  } else if (baseParsed && !baseData) {
    // A base declaration that exists but does not parse cannot be compared: never a silent pass.
    results.push(
      unproven(
        "ratchet",
        `the base's playbook.json does not parse: ${baseParsed.errors[0] ?? "?"}`,
        {
          fix: "repair playbook.json on the base branch first",
        },
      ),
    );
  } else if (baseData) {
    const ratchet = declarationRatchet(
      head,
      baseData,
      (rel) => readWorktreeFile(root, rel),
      (rel) => showFile(root, base.sha!, rel),
      (rel) => trackedFileScope(root, rel),
    );
    const issues = await judgeIssueBacked(root, ratchet.issueBacked, options);
    reported = reportedCommandChanges(head, baseData);
    const accepted =
      issues.accepted.length > 0
        ? `; ${issues.accepted.length} size exception(s) with an open issue (§1.3): ${issues.accepted.join(", ")}`
        : "";
    const result = await held(
      "ratchet",
      [...ratchet.problems, ...issues.problems],
      "playbook.json only tightens",
      ask,
      "restore the setting, or name an open refactor issue in a one-file size exception (§1.3)",
    );
    results.push(
      result.status === "PASS" ? { ...result, summary: result.summary + accepted } : result,
    );
  }
  const exceptionsHead = readWorktreeFile(root, EXCEPTIONS_SOURCE);
  if (base.sha && exceptionsHead !== null) {
    const changes = exceptionChanges(
      parseJsonOrEmpty(exceptionsHead),
      parseJsonOrEmpty(showFile(root, base.sha, EXCEPTIONS_SOURCE)),
    );
    results.push(await held("exceptions", changes, "no exception added", ask, "remove the entry"));
  }

  const wanted = options.contracts && options.contracts.length > 0 ? options.contracts : null;
  const body = readBody(options);

  for (const name of CONTRACT_NAMES) {
    if (wanted && !wanted.includes(name)) continue;
    if (options.signal?.aborted) {
      results.push(unproven(name, "the run was cancelled before this check started"));
      continue;
    }
    const why = bypassReason(bypasses, name);
    if (why) {
      results.push(passed(name, `bypassed by owner (${why})`));
      continue;
    }
    const raw = contractsOf(head)[name];
    if (raw === undefined) {
      results.push(
        unproven(
          name,
          'contract is neither declared nor opted out with {"none": "<reason>"} (§1.2)',
          {
            fix: `declare contracts.${name} or opt out with {"none": "<reason>"} in playbook.json`,
          },
        ),
      );
      continue;
    }
    if (optedOut(raw)) {
      results.push(passed(name, `not applicable: ${String((raw as { none: unknown }).none)}`));
      continue;
    }
    const settings = contractSettings(head, name);
    if (name === "intent") {
      if (isRecord(settings.contracts)) {
        results.push(...intentGate(root, settings, base.sha, body, options.env));
      } else {
        results.push(
          validateSectionEvidence({ root, section: name, settings, evidenceDir, env: options.env }),
        );
      }
      continue;
    }
    results.push(
      validateSectionEvidence({ root, section: name, settings, evidenceDir, env: options.env }),
    );
  }

  const runCi = wanted === null || wanted.includes("ci");
  if (runCi) {
    if (options.signal?.aborted) {
      results.push(unproven("ci", "the run was cancelled before this check started"));
    } else {
      const why = bypassReason(bypasses, "ci");
      if (why) {
        results.push(passed("ci", `bypassed by owner (${why})`));
      } else if (head.ci === undefined) {
        results.push(
          unproven(
            "ci",
            'ci block is neither declared nor opted out with {"none": "<reason>"} (§1.2, §14)',
            {
              fix: 'declare ci or opt out with {"none": "<reason>"} in playbook.json',
            },
          ),
        );
      } else if (optedOut(head.ci)) {
        results.push(
          passed("ci", `not applicable: ${String((head.ci as { none: unknown }).none)}`),
        );
      } else {
        const ciSettings = isRecord(head.ci) ? head.ci : {};
        results.push(
          validateSectionEvidence({
            root,
            section: "ci",
            settings: ciSettings,
            evidenceDir,
            env: options.env,
          }),
        );
      }
    }
  }

  return { repo, base: base.sha, results, reported, exitCode: exitCodeFor(results) };
}
