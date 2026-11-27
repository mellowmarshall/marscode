/**
 * The file size ratchet (PLAYBOOK §3): the repo's `size.command` reports code lines per file;
 * a file over 500 needs a Baseline entry, which only moves down and goes once the file fits.
 */
import type { BaselineEntry } from "./baseline.ts";
import { failed, passed, unproven, type CheckResult } from "./result.ts";
import { runStep, tailLines } from "./steps.ts";
import { isRecord } from "./strictJson.ts";

const SIZE_LIMIT = 500;
const CHECK = "size";

export interface SizeReport {
  readonly counts: ReadonlyMap<string, number>;
  readonly problems: ReadonlyArray<string>;
}

function parseSizeReport(stdout: string, command: string): SizeReport {
  let report: unknown;
  try {
    report = JSON.parse(stdout) as unknown;
  } catch (cause) {
    return {
      counts: new Map(),
      problems: [`\`${command}\` printed no JSON object (${String(cause)})`],
    };
  }
  if (!isRecord(report)) {
    return {
      counts: new Map(),
      problems: [`\`${command}\` printed no object of {"<file>": lines}`],
    };
  }
  const counts = new Map<string, number>();
  const problems: string[] = [];
  for (const [key, n] of Object.entries(report).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      problems.push(`${key}: the report's count ${JSON.stringify(n)} is not a whole number`);
    } else if (!key.includes("#")) {
      counts.set(key, n);
    }
  }
  return { counts, problems };
}

/** Judge COUNTS against the size Baseline ENTRIES. */
function judgeSize(
  counts: ReadonlyMap<string, number>,
  entries: ReadonlyArray<BaselineEntry>,
): ReadonlyArray<string> {
  const held = new Map(entries.filter((e) => e.rule === "size").map((e) => [e.file, e] as const));
  const problems: string[] = [];
  for (const [file, lines] of counts) {
    const entry = held.get(file);
    if (lines > SIZE_LIMIT) {
      if (!entry || entry.lines === null) {
        problems.push(`${file}: ${lines} code lines, over the ${SIZE_LIMIT}-line limit`);
      } else if (lines > entry.lines) {
        problems.push(`${file}: ${lines} code lines, above its Baseline's ${entry.lines}`);
      } else if (lines < entry.lines) {
        problems.push(
          `${file}: shrank to ${lines}; move its Baseline entry down from ${entry.lines}`,
        );
      }
    } else if (entry) {
      problems.push(`${file}: ${lines} code lines is within the limit; remove its Baseline entry`);
    }
  }
  return problems;
}

export async function sizeGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly base: string | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<CheckResult> {
  const command = input.settings.command;
  if (typeof command !== "string" || !command.trim()) {
    return failed(CHECK, "contracts.size.command is not declared", {
      fix: "declare the command that counts the repo's code lines (PLAYBOOK §3)",
    });
  }
  const run = await runStep(
    input.root,
    command,
    { PLAYBOOK_BASE: input.base ?? "" },
    undefined,
    input.signal,
  );
  if (run.code === null) return unproven(CHECK, `\`${command}\` did not run: ${run.why}`);
  if (run.code !== 0) {
    return failed(CHECK, `\`${command}\` exited ${run.code}`, { errors: tailLines(run, 5) });
  }
  const report = parseSizeReport(run.stdout, command);
  const problems = [...report.problems, ...judgeSize(report.counts, input.entries)];
  if (problems.length > 0) {
    return failed(CHECK, `${problems.length} size problem(s)`, {
      errors: problems,
      fix: `split the file along a domain seam to ${SIZE_LIMIT} lines or under`,
    });
  }
  return passed(
    CHECK,
    `${report.counts.size} file(s) within ${SIZE_LIMIT} lines or their Baseline`,
  );
}
