// @effect-diagnostics nodeBuiltinImport:off - Reads the PR body file named on the command line.
/**
 * `playbook intent-diff` (the changes intent would judge, against the gate's base; exit 2 when
 * they cannot be compared) and `playbook intent-audit` (one record per declared change at the
 * merged commit; exit 1 when the merge no longer matches the body), as the original prints them.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import {
  CONTRACT_NAMES as INTENT_CONTRACTS,
  contractDiff,
  judgeIntent,
  runIntentDiff,
  type ContractChange,
  type ContractName as IntentContract,
} from "@t3tools/surface";

import { choiceError } from "./cliUsage.ts";
import {
  contractSettings,
  DECLARATION,
  loadDeclaration,
  parseDeclarationText,
} from "./declaration.ts";
import type { DeclarationData } from "./declaration.ts";
import { resolveCommit, showFile } from "./git.ts";
import { EXIT_FAIL, EXIT_USAGE } from "./result.ts";
import { isRecord } from "./strictJson.ts";

/** The contract names `--contract` accepts (walks: a declared walks file, which this playbook has no form for). */
const INTENT_DIFF_CHOICES: ReadonlyArray<string> = [...INTENT_CONTRACTS, "walks"];

interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
}

/** {contract: file} that intent judges: the declaration's `contracts.intent.contracts`. */
function judgedFiles(data: DeclarationData | null): Partial<Record<IntentContract, string>> {
  const declared = contractSettings(data, "intent").contracts;
  const out: Partial<Record<IntentContract, string>> = {};
  if (!isRecord(declared)) return out;
  for (const name of INTENT_CONTRACTS) {
    const path = declared[name];
    if (typeof path === "string" && path) out[name] = path;
  }
  return out;
}

export function cmdIntentDiff(root: string, args: ReadonlyArray<string>, io: Io): number {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      contract: { type: "string", multiple: true },
      json: { type: "boolean" },
    },
  });
  const only = values.contract ?? [];
  for (const name of only) {
    const problem = choiceError("intent-diff", "--contract", name, INTENT_DIFF_CHOICES);
    if (problem) {
      io.err(problem);
      return EXIT_USAGE;
    }
  }
  const files = Object.fromEntries(
    Object.entries(judgedFiles(loadDeclaration(root).data)).filter(
      ([name]) => only.length === 0 || only.includes(name),
    ),
  );
  return runIntentDiff({
    root,
    files,
    base: values.base ?? null,
    json: values.json === true,
    env: io.env,
    out: (text) => io.out(text.replace(/\n$/, "")),
    err: (text) => io.err(text.replace(/\n$/, "")),
  });
}

function parseObject(text: string | null): Record<string, unknown> {
  const data: unknown = text ? JSON.parse(text) : {};
  return isRecord(data) ? data : {};
}

/** The changes between two commits, the contracts new at the second, and what cannot be compared. */
function commitChanges(
  root: string,
  files: Partial<Record<IntentContract, string>>,
  base: string,
  merged: string,
): { changes: ContractChange[]; fresh: Set<string>; errors: string[] } {
  const changes: ContractChange[] = [];
  const fresh = new Set<string>();
  const errors: string[] = [];
  const baseSha = resolveCommit(root, base);
  const mergedSha = resolveCommit(root, merged);
  for (const [contract, path] of Object.entries(files) as Array<[IntentContract, string]>) {
    if (baseSha === null || mergedSha === null) {
      errors.push(`${baseSha === null ? base : merged} is not a commit here`);
      continue;
    }
    const beforeText = showFile(root, baseSha, path);
    try {
      changes.push(
        ...contractDiff(
          contract,
          parseObject(beforeText),
          parseObject(showFile(root, mergedSha, path)),
        ),
      );
    } catch (cause) {
      errors.push(
        `${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      continue;
    }
    if (beforeText === null) fresh.add(contract);
  }
  return { changes, fresh, errors };
}

function readBody(path: string | undefined): string {
  if (!path) return "";
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function cmdIntentAudit(root: string, args: ReadonlyArray<string>, io: Io): number {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: { base: { type: "string" }, merged: { type: "string" }, body: { type: "string" } },
  });
  const missing = (["base", "merged"] as const).filter((k) => values[k] === undefined);
  if (missing.length > 0) {
    io.err(
      `playbook intent-audit: error: the following arguments are required: ${missing.map((k) => `--${k}`).join(", ")}`,
    );
    return EXIT_USAGE;
  }
  const base = values.base!;
  const merged = values.merged!;
  const mergedSha = resolveCommit(root, merged);
  if (mergedSha === null) {
    io.err(`playbook intent-audit: ${merged} is not a commit here`);
    return EXIT_USAGE;
  }
  const text = showFile(root, mergedSha, DECLARATION);
  const files = judgedFiles(text ? parseDeclarationText(text).data : null);
  if (Object.keys(files).length === 0) {
    io.out(
      "playbook intent-audit: the merged playbook.json declares no intent contracts; nothing to record",
    );
    return 0;
  }
  const body = readBody(values.body ?? io.env.SHIP_QUEUE_BODYFILE);
  const { changes, fresh, errors } = commitChanges(root, files, base, merged);
  const judged =
    errors.length > 0 ? { issues: errors, audited: [] } : judgeIntent(changes, body, fresh);
  for (const a of judged.audited) {
    io.out(
      `contract-intent audit: ${a.action} ${a.contract} ${a.item} (${a.why}) merged=${merged}`,
    );
  }
  for (const line of judged.issues)
    io.out(`contract-intent audit: MISMATCH ${line} merged=${merged}`);
  io.out(`contract-intent audit: ${judged.audited.length} record(s) at merged=${merged}`);
  return judged.issues.length > 0 ? EXIT_FAIL : 0;
}
