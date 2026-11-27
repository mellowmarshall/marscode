/**
 * Contract intent (PLAYBOOK §5): composes directly with @t3tools/surface's item diff and
 * intent judge while reading files through @t3tools/playbook's hardened git/worktree layer.
 */
import {
  CONTRACT_NAMES as SURFACE_CONTRACT_NAMES,
  contractDiff as surfaceContractDiff,
  judgeIntent,
  type ContractChange,
  type ContractName as IntentContract,
} from "@t3tools/surface";

import { mergeBase, readWorktreeFile, showFile } from "./git.ts";
import { failed, passed, unproven, type CheckResult } from "./result.ts";
import { isRecord } from "./strictJson.ts";

function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function surfaceRouteCount(root: string, path: string): number | null {
  const text = readWorktreeFile(root, path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.routes)) return null;
    return Object.keys(parsed.routes).length;
  } catch {
    return null;
  }
}

/** Run the `intent` contract gate on the real worktree using @t3tools/surface. */
export function intentGate(
  root: string,
  settings: Readonly<Record<string, unknown>>,
  baseSha: string | null,
  body: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<CheckResult> {
  const files = isRecord(settings.contracts) ? settings.contracts : {};
  const results: CheckResult[] = [];
  if (typeof files.surface === "string") {
    const count = surfaceRouteCount(root, files.surface);
    if (!count) {
      const found = count === null ? "cannot be read" : "records 0 routes";
      results.push(
        unproven(
          "intent",
          `the surface ${files.surface} ${found}; the repo declares an API, so its routes are not proven`,
          {
            files: [files.surface],
            fix: "regenerate the surface (the repo's generate command) with the API's route roots configured",
          },
        ),
      );
    }
  }
  if (baseSha === null) {
    return [
      ...results,
      unproven("intent", "no base: contract changes cannot be compared", {
        fix: "git fetch origin",
      }),
    ];
  }
  const start = mergeBase(root, "HEAD", baseSha) ?? baseSha;
  const changes: ContractChange[] = [];
  const fresh = new Set<string>();
  const parseErrors: string[] = [];
  for (const [contract, path] of Object.entries(files)) {
    if (
      typeof path !== "string" ||
      !(SURFACE_CONTRACT_NAMES as ReadonlyArray<string>).includes(contract)
    ) {
      continue;
    }
    const before = showFile(root, start, path);
    if (before === null) fresh.add(contract);
    const after = readWorktreeFile(root, path);
    if (after !== null) {
      try {
        JSON.parse(after);
      } catch (cause) {
        parseErrors.push(`${path} is not valid JSON: ${String(cause)}`);
        continue;
      }
    }
    changes.push(
      ...surfaceContractDiff(
        contract as IntentContract,
        parseJsonObject(before),
        parseJsonObject(after),
      ),
    );
  }
  if (parseErrors.length > 0) {
    return [
      ...results,
      unproven("intent", "a contract file cannot be compared", { errors: parseErrors }),
    ];
  }
  const effectiveBody = body === null && env.SHIP_QUEUE_JOB ? "" : body;
  if (effectiveBody === null && changes.length > 0) {
    return [
      ...results,
      unproven("intent", `${changes.length} contract change(s) and no PR body`, {
        errors: changes.map((c) => `${c.action} ${c.contract} ${c.item}`),
        fix: "pass --pr-body <body.md> locally, or ship through the queue",
      }),
    ];
  }
  const { issues, audited } = judgeIntent(changes, effectiveBody ?? "", fresh);
  if (issues.length > 0) {
    return [
      ...results,
      failed("intent", `${issues.length} contract intent problem(s)`, {
        errors: issues,
        fix: "## Contract Intent / - ADD|REMOVE|MODIFY <contract> <item> (why)",
      }),
    ];
  }
  return [...results, passed("intent", `${audited.length} contract change(s) declared exactly`)];
}
