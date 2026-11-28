/**
 * The contract changes intent would judge, as the original `playbook intent-diff`
 * prints them: one `ACTION contract item` line each (a MODIFY names the fields
 * that differ), from where the branch left its base to the working tree. Exit 0,
 * or 2 when the changes cannot be compared. `surface diff` is this for the surface.
 */
import { gateBase, resolveCommit } from "./surfaceBase.ts";
import { contractSides, type ContractSide, mergeBase } from "./surfaceIntentCheck.ts";
import { contractDiff, contractValues, modifiedFields } from "./surfaceIntentItems.ts";
import type { ContractName } from "./surfaceLocate.ts";
import { pythonJsonDumps } from "./surfaceRender.ts";

export interface IntentDiffRow {
  readonly action: string;
  readonly contract: string;
  readonly item: string;
  readonly fields: ReadonlyArray<string>;
}

/** Every change of each side, with the fields a MODIFY changes. */
export function intentDiffRows(
  sides: ReadonlyArray<Pick<ContractSide, "contract" | "before" | "after">>,
): IntentDiffRow[] {
  const rows: IntentDiffRow[] = [];
  for (const { contract, before, after } of sides) {
    const [old, next] = contractValues(contract, before, after);
    for (const change of contractDiff(contract, before, after)) {
      const fields =
        change.action === "MODIFY"
          ? modifiedFields(old.get(change.item) ?? "null", next.get(change.item) ?? "null")
          : [];
      rows.push({ action: change.action, contract, item: change.item, fields });
    }
  }
  return rows;
}

/** The text form: a line per change, then the count against the base's short sha. */
export function renderIntentDiff(rows: ReadonlyArray<IntentDiffRow>, start: string): string {
  const lines = rows.map(
    (r) =>
      `${r.action} ${r.contract} ${r.item}` +
      (r.fields.length > 0 ? ` (${r.fields.join("; ")})` : ""),
  );
  lines.push(`intent-diff: ${rows.length} contract change(s) against ${start.slice(0, 12)}`);
  return lines.join("\n");
}

export interface IntentDiffInput {
  readonly root: string;
  /** The declared intent contract files to compare, already narrowed to the ones asked for. */
  readonly files: Partial<Record<ContractName, string>>;
  /** The base asked for; null: the gate's base. */
  readonly base: string | null;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Runs the intent diff; returns its exit code. */
export function runIntentDiff(input: IntentDiffInput): number {
  const { root, files, base, out, err } = input;
  if (Object.keys(files).length === 0) {
    err(
      "playbook intent-diff: playbook.json declares no such intent contract (contracts.intent.contracts)\n",
    );
    return 2;
  }
  const ref = base ? resolveCommit(root, base) : gateBase(root, input.env).sha;
  if (!ref) {
    err(
      `playbook intent-diff: no base to compare against (${base || "the gate base"}); git fetch origin\n`,
    );
    return 2;
  }
  const start = mergeBase(root, ref) ?? ref;
  const { sides, errors } = contractSides(root, files, start);
  for (const line of errors) err(`playbook intent-diff: ${line}\n`);
  if (errors.length > 0) return 2;
  const rows = intentDiffRows(sides);
  out(
    `${input.json ? pythonJsonDumps({ base: start, changes: rows }) : renderIntentDiff(rows, start)}\n`,
  );
  return 0;
}
