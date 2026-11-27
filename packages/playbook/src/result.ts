/**
 * Gate results: PASS, FAIL, or UNPROVEN (the gate could not look; never a pass).
 * Exit codes: 0 every check passed, 1 any check failed, 3 nothing failed but at
 * least one check is unproven or no check produced a result.
 */
export type CheckStatus = "PASS" | "FAIL" | "UNPROVEN";

export interface CheckResult {
  readonly check: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly errors: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly fix: string | null;
}

const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
const EXIT_UNPROVEN = 3;

const MAX_LINES = 10;

interface Detail {
  readonly errors?: ReadonlyArray<string> | undefined;
  readonly files?: ReadonlyArray<string> | undefined;
  readonly fix?: string | undefined;
}

export const passed = (check: string, summary: string): CheckResult => ({
  check,
  status: "PASS",
  summary,
  errors: [],
  files: [],
  fix: null,
});

export const failed = (check: string, summary: string, detail: Detail = {}): CheckResult => ({
  check,
  status: "FAIL",
  summary,
  errors: detail.errors ?? [],
  files: detail.files ?? [],
  fix: detail.fix ?? null,
});

export const unproven = (check: string, summary: string, detail: Detail = {}): CheckResult => ({
  check,
  status: "UNPROVEN",
  summary,
  errors: detail.errors ?? [],
  files: detail.files ?? [],
  fix: detail.fix ?? null,
});

export function exitCodeFor(results: ReadonlyArray<CheckResult>): number {
  if (results.some((r) => r.status === "FAIL")) return EXIT_FAIL;
  if (results.length === 0 || results.some((r) => r.status === "UNPROVEN")) return EXIT_UNPROVEN;
  return EXIT_PASS;
}

/** One line for a pass; at most MAX_LINES for a failing or unproven check. */
export function renderResult(result: CheckResult): string {
  const head = `${result.status} ${result.check}: ${result.summary}`;
  if (result.status === "PASS") return head;
  const lines = [head];
  for (const error of result.errors) {
    if (lines.length >= MAX_LINES - 2) {
      lines.push(`  ... ${result.errors.length - (lines.length - 1)} more`);
      break;
    }
    lines.push(`  - ${error}`);
  }
  if (result.files.length > 0) lines.push(`  files: ${result.files.slice(0, 8).join(", ")}`);
  if (result.fix) lines.push(`  fix: ${result.fix}`);
  return lines.join("\n");
}
