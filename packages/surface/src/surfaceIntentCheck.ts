// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * `surface check`: every contract change since the branch left its base is declared,
 * and only those. A surface file with no route is UNPROVEN, never a pass. The body
 * is `--body`, else SHIP_QUEUE_BODYFILE; a queue job with no body file has an empty one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveCommit } from "./surfaceBase.ts";
import { type ContractChange, contractDiff } from "./surfaceIntentItems.ts";
import { describe, judgeIntent } from "./surfaceIntentJudge.ts";
import { type ContractName, declaredContracts, findContractPath } from "./surfaceLocate.ts";

export type Verdict = "pass" | "fail" | "unproven";

export interface IntentResult {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly errors: ReadonlyArray<string>;
  readonly fix?: string;
}

type Json = Record<string, unknown>;

function git(root: string, args: ReadonlyArray<string>): { status: number | null; stdout: string } {
  const res = NodeChildProcess.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/** A file's text at a commit; null when the commit lacks it. Throws on a commit that does not exist. */
export function showAt(root: string, ref: string, path: string): string | null {
  if (resolveCommit(root, ref) === null) throw new Error(`${ref} is not a commit here`);
  const res = git(root, ["show", `${ref}:${path}`]);
  return res.status === 0 ? res.stdout : null;
}

function readText(root: string, path: string): string | null {
  try {
    return NodeFS.readFileSync(NodePath.join(root, path), "utf8");
  } catch {
    return null;
  }
}

function parseObject(text: string | null): Json {
  const data: unknown = text ? JSON.parse(text) : {};
  return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Json) : {};
}

export function mergeBase(root: string, base: string): string | null {
  const res = git(root, ["merge-base", "HEAD", base]);
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** The contract files to judge: the ones playbook.json declares, else the surface file found. */
export function intentFiles(root: string): Partial<Record<ContractName, string>> {
  const declared = declaredContracts(root);
  if (Object.keys(declared).length > 0) return declared;
  const found = findContractPath(root);
  return found ? { surface: NodePath.relative(root, found) } : {};
}

/** One contract file at the base commit and in the working tree. */
export interface ContractSide {
  readonly contract: ContractName;
  readonly before: Json;
  readonly after: Json;
  /** The file is new on the branch. */
  readonly fresh: boolean;
}

/** Each contract file at the base commit and in the working tree; a file that cannot be compared is an error. */
export function contractSides(
  root: string,
  files: Partial<Record<ContractName, string>>,
  base: string,
): { readonly sides: ContractSide[]; readonly errors: string[] } {
  const sides: ContractSide[] = [];
  const errors: string[] = [];
  for (const [contract, path] of Object.entries(files) as Array<[ContractName, string]>) {
    let beforeText: string | null;
    try {
      beforeText = showAt(root, base, path);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    try {
      const before = parseObject(beforeText);
      const after = parseObject(readText(root, path));
      sides.push({ contract, before, after, fresh: beforeText === null });
    } catch (error) {
      errors.push(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }
  return { sides, errors };
}

export interface Changes {
  readonly changes: ContractChange[];
  /** Contracts new on the branch. */
  readonly fresh: Set<string>;
  readonly errors: string[];
}

/** The changes from the base commit to the working tree. */
export function contractChanges(
  root: string,
  files: Partial<Record<ContractName, string>>,
  base: string,
): Changes {
  const { sides, errors } = contractSides(root, files, base);
  return {
    changes: sides.flatMap((s) => contractDiff(s.contract, s.before, s.after)),
    fresh: new Set(sides.filter((s) => s.fresh).map((s) => s.contract)),
    errors,
  };
}

/** Routes in the working tree's surface file; null when it cannot be read. */
export function routeCount(root: string, path: string): number | null {
  try {
    const routes = parseObject(readText(root, path)).routes;
    return routes !== null && typeof routes === "object" && !Array.isArray(routes)
      ? Object.keys(routes).length
      : null;
  } catch {
    return null;
  }
}

export interface IntentCheckInput {
  readonly root: string;
  readonly base: string | null;
  /** The PR body; null when none was given. */
  readonly body: string | null;
  readonly inQueueJob: boolean;
}

export function checkIntent(input: IntentCheckInput): IntentResult[] {
  const { root, base, inQueueJob } = input;
  const files = intentFiles(root);
  const results: IntentResult[] = [];
  if (files.surface) {
    const count = routeCount(root, files.surface);
    if (!count) {
      const found = count === null ? "cannot be read" : "records 0 routes";
      results.push({
        verdict: "unproven",
        summary: `the surface ${files.surface} ${found}; the repo declares an API, so its routes are not proven`,
        errors: [],
        fix: "regenerate the surface (the repo's generate command) with the API's route roots configured",
      });
    }
  }
  if (base === null) {
    return [
      ...results,
      {
        verdict: "unproven",
        summary: "no base: contract changes cannot be compared",
        errors: [],
        fix: "git fetch origin",
      },
    ];
  }
  const start = mergeBase(root, base) ?? base;
  const { changes, fresh, errors } = contractChanges(root, files, start);
  if (errors.length > 0) {
    return [
      ...results,
      { verdict: "unproven", summary: "a contract file cannot be compared", errors },
    ];
  }
  let body = input.body;
  if (body === null && inQueueJob) body = "";
  if (body === null) {
    if (changes.length > 0) {
      return [
        ...results,
        {
          verdict: "unproven",
          summary: `${changes.length} contract change(s) and no PR body (SHIP_QUEUE_BODYFILE or --body): intent cannot be checked`,
          errors: changes.map(describe),
          fix: "pass --body <body.md> locally, or ship through the queue",
        },
      ];
    }
    body = "";
  }
  const { issues, audited } = judgeIntent(changes, body, fresh);
  if (issues.length > 0) {
    return [
      ...results,
      {
        verdict: "fail",
        summary: `${issues.length} contract intent problem(s)`,
        errors: issues,
        fix: "declare each change in the PR body: ## Contract Intent / - ADD|REMOVE|MODIFY <contract> <item> (why)",
      },
    ];
  }
  const count = Object.keys(files).length;
  return [
    ...results,
    {
      verdict: "pass",
      summary: `${audited.length} contract change(s) declared exactly across ${count} contract file(s)`,
      errors: [],
    },
  ];
}

/** The exit code of a set of results: 1 on a failure, 3 when anything is unproven, else 0. */
export function exitCodeOf(results: ReadonlyArray<IntentResult>): number {
  if (results.some((r) => r.verdict === "fail")) return 1;
  if (results.some((r) => r.verdict === "unproven")) return 3;
  return 0;
}

export function renderIntentResults(results: ReadonlyArray<IntentResult>): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`intent: ${r.verdict.toUpperCase()} ${r.summary}`);
    for (const e of r.errors) lines.push(`  - ${e}`);
    if (r.fix && r.verdict !== "pass") lines.push(`  fix: ${r.fix}`);
  }
  return lines.join("\n");
}
