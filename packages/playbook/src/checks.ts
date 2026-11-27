// @effect-diagnostics nodeBuiltinImport:off - Reads the PR body file and the real worktree for `playbook check`.
/**
 * `playbook check`: the declaration, its ratchets, every Baseline and each declared gate, read
 * from the real worktree against the gate base. Owner overrides are asked through OVERRIDE.
 */
import * as NodeFS from "node:fs";

import {
  baselineGrowth,
  expiredEntries,
  parseBaseline,
  tooFarEntries,
  type BaselineEntry,
} from "./baseline.ts";
import { bypassReason, exceptionChanges, EXCEPTIONS_SOURCE, type Bypasses } from "./bypass.ts";
import {
  CONTRACT_NAMES,
  contractsOf,
  contractSettings,
  loadDeclaration,
  optedOut,
  parseDeclarationText,
  type DeclarationData,
} from "./declaration.ts";
import { gateBase, mergeBase, readWorktreeFile, showFile, type GateBase } from "./git.ts";
import {
  contractDiff,
  INTENT_CONTRACTS,
  judgeContractIntent,
  type ContractChange,
  type IntentContract,
} from "./intent.ts";
import { loosenedDeclaration, reportedCommandChanges } from "./ratchet.ts";
import { exitCodeFor, failed, passed, unproven, type CheckResult } from "./result.ts";
import { sizeGate } from "./sizeGate.ts";
import { runStep, tailLines } from "./steps.ts";
import { isRecord } from "./strictJson.ts";

/** Asks the owner (the T3 guard broker) to let REASON through; true when granted. */
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
  /** Aborting stops the run: the step running is killed and no later gate starts. */
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

async function baselineResults(
  root: string,
  name: string,
  head: DeclarationData,
  baseData: DeclarationData | null,
  baseSha: string | null,
  today: string,
  ask: OverrideAsk,
): Promise<{ readonly results: CheckResult[]; readonly entries: ReadonlyArray<BaselineEntry> }> {
  const path = contractSettings(head, name).baseline;
  if (typeof path !== "string") return { results: [], entries: [] };
  const check = `baseline ${name}`;
  const text = readWorktreeFile(root, path);
  if (text === null)
    return { results: [failed(check, `${path}: declared but missing`)], entries: [] };
  const current = parseBaseline(text, path);
  if (current.errors.length > 0) {
    return {
      results: [failed(check, current.errors[0]!, { errors: current.errors })],
      entries: [],
    };
  }
  const results: CheckResult[] = [];
  const expired = expiredEntries(current.entries, today);
  const far = tooFarEntries(current.entries, today);
  if (expired.length > 0 || far.length > 0) {
    results.push(
      failed(check, `${expired.length} expired, ${far.length} past the 180-day limit`, {
        errors: [
          ...expired.map((e) => `expired: ${e.file} [${e.rule}] ${e.expires}`),
          ...far.map((e) => `too far: ${e.file} [${e.rule}] ${e.expires}`),
        ],
        files: [path],
      }),
    );
  }
  const adopting = baseData === null || !(name in contractsOf(baseData));
  const basePath = contractSettings(baseData, name).baseline;
  const baseText =
    baseSha && typeof basePath === "string" ? showFile(root, baseSha, basePath) : null;
  const base = baseText ? parseBaseline(baseText, `${basePath as string}@base`).entries : [];
  const growth = baselineGrowth(current.entries, base, { adopting: adopting || base.length === 0 });
  results.push(
    await held(check, growth, `${current.entries.length} entr(ies), shrink-only`, ask, "shrink it"),
  );
  return { results, entries: current.entries };
}

function intentGate(
  root: string,
  settings: Readonly<Record<string, unknown>>,
  baseSha: string | null,
  body: string | null,
): CheckResult {
  const files = isRecord(settings.contracts) ? settings.contracts : {};
  if (baseSha === null) return unproven("intent", "no base: contract changes cannot be compared");
  const start = mergeBase(root, "HEAD", baseSha) ?? baseSha;
  const changes: ContractChange[] = [];
  const fresh = new Set<string>();
  for (const [contract, path] of Object.entries(files)) {
    if (typeof path !== "string" || !INTENT_CONTRACTS.includes(contract as IntentContract))
      continue;
    const before = showFile(root, start, path);
    if (before === null) fresh.add(contract);
    const after = readWorktreeFile(root, path);
    changes.push(
      ...contractDiff(
        contract as IntentContract,
        parseJsonOrEmpty(before),
        parseJsonOrEmpty(after),
      ),
    );
  }
  if (body === null && changes.length > 0) {
    return unproven("intent", `${changes.length} contract change(s) and no PR body`, {
      errors: changes.map((c) => `${c.action} ${c.contract} ${c.item}`),
      fix: "pass --pr-body <body.md> locally, or ship through the queue",
    });
  }
  const { issues, audited } = judgeContractIntent(changes, body ?? "", fresh);
  if (issues.length > 0) {
    return failed("intent", `${issues.length} contract intent problem(s)`, {
      errors: issues,
      fix: "## Contract Intent / - ADD|REMOVE|MODIFY <contract> <item> (why)",
    });
  }
  return passed("intent", `${audited.length} contract change(s) declared exactly`);
}

async function toolsGate(
  root: string,
  settings: Readonly<Record<string, unknown>>,
  base: string | null,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<CheckResult>> {
  const steps = Array.isArray(settings.steps) ? settings.steps.filter(isRecord) : [];
  if (steps.length === 0) return [passed("tools", "no declared steps")];
  const results: CheckResult[] = [];
  for (const step of steps) {
    const name = `tools ${String(step.name)}`;
    const run = await runStep(
      root,
      String(step.run),
      { PLAYBOOK_BASE: base ?? "" },
      undefined,
      signal,
    );
    if (run.code === null) {
      results.push(unproven(name, `\`${String(step.run)}\` did not run: ${run.why}`));
    } else if (run.code === 0) {
      results.push(passed(name, `\`${String(step.run)}\` exited 0`));
    } else {
      const errors = tailLines(run, 5);
      results.push(failed(name, `\`${String(step.run)}\` exited ${run.code}`, { errors }));
    }
  }
  return results;
}

/** Run the declared contracts' gates on the real worktree. */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const { root, repo, today, bypasses } = options;
  const ask = options.override ?? noOverride;
  const decl = loadDeclaration(root);
  if (decl.data === null || decl.errors.length > 0) {
    const results = [failed("declaration", decl.errors[0] ?? "invalid", { errors: decl.errors })];
    return { repo, base: null, results, reported: [], exitCode: exitCodeFor(results) };
  }
  const head = decl.data;
  const base = options.base ?? gateBase(root, options.env);
  const results: CheckResult[] = [passed("declaration", "playbook.json is valid")];
  const baseText = base.sha ? showFile(root, base.sha, "playbook.json") : null;
  const baseData = baseText ? parseDeclarationText(baseText, { base: true }).data : null;
  let reported: ReadonlyArray<string> = [];
  if (!base.sha) {
    results.push(unproven("ratchet", base.problem ?? "no base", { fix: "git fetch origin" }));
  } else if (bypassReason(bypasses, "ratchet")) {
    results.push(passed("ratchet", `bypassed by owner (${bypassReason(bypasses, "ratchet")})`));
  } else if (baseData) {
    const problems = loosenedDeclaration(head, baseData, (rel) => readWorktreeFile(root, rel));
    reported = reportedCommandChanges(head, baseData);
    results.push(
      await held("ratchet", problems, "playbook.json only tightens", ask, "restore the setting"),
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
      results.push(unproven(name, "the run was cancelled before this gate started"));
      continue;
    }
    const body0 = contractsOf(head)[name];
    if (body0 === undefined) continue;
    const why = bypassReason(bypasses, name);
    if (why) {
      results.push(passed(name, `bypassed by owner (${why})`));
      continue;
    }
    if (optedOut(body0)) {
      results.push(passed(name, `not applicable: ${String((body0 as { none: unknown }).none)}`));
      continue;
    }
    const settings = contractSettings(head, name);
    const bl = await baselineResults(root, name, head, baseData, base.sha, today, ask);
    results.push(...bl.results);
    if (name === "size") {
      results.push(
        await sizeGate({
          root,
          settings,
          entries: bl.entries,
          base: base.sha,
          signal: options.signal,
        }),
      );
    } else if (name === "intent") {
      results.push(intentGate(root, settings, base.sha, body));
    } else if (name === "tools") {
      results.push(...(await toolsGate(root, settings, base.sha, options.signal)));
    } else {
      results.push(
        unproven(name, "this contract's gate is not in the TypeScript engine yet", {
          fix: "track the port on the playbook engine issue",
        }),
      );
    }
  }
  return { repo, base: base.sha, results, reported, exitCode: exitCodeFor(results) };
}
