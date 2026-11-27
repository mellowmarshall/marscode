/**
 * The result one test-runner parser finds in a log, and the line helpers every
 * parser shares (a port of an earlier Python runlog formats module).
 *
 * A failure keeps its log line number: the summary's detail is the earliest
 * failure across all formats found in one log.
 */

/** At most this many lines of a failure's detail are shown. */
export const DETAIL_LINES = 20;

/** What `passed` and `failed` count: `go test` without `-v` counts packages. */
export type CountUnit = "tests" | "packages";

export interface FailureDetail {
  readonly line: number;
  readonly lines: ReadonlyArray<string>;
}

export class Found {
  fmt: string;
  passed = 0;
  failed = 0;
  skipped = 0;
  /** (log line, case name) of each failing case. */
  failures: Array<[number, string]> = [];
  /** The first failure's detail. */
  detail: FailureDetail | null = null;
  unit: CountUnit = "tests";
  /** A merged result's [passed, failed, skipped] per unit, in first-seen order. */
  units: Map<CountUnit, [number, number, number]> = new Map();

  constructor(fmt: string) {
    this.fmt = fmt;
  }

  failAt(line: number, name: string): void {
    this.failures.push([line, name.trim()]);
  }

  detailAt(line: number, lines: ReadonlyArray<string>): void {
    if (this.detail === null || line < this.detail.line) {
      this.detail = { line, lines: trim(lines) };
    }
  }
}

/** A test-runner parser: a Found when it recognises its runner's output, else null. */
export type RunnerParser = (lines: ReadonlyArray<string>) => Found | null;

/** Drops trailing blank lines and keeps at most DETAIL_LINES. */
export function trim(lines: ReadonlyArray<string>): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(0, Math.min(end, DETAIL_LINES));
}

/** lines[start] and the lines after it, up to (not including) the first later line `stop` accepts. */
export function block(
  lines: ReadonlyArray<string>,
  start: number,
  stop: (line: string) => boolean,
): string[] {
  const out = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1, start + 200)) {
    if (stop(line)) break;
    out.push(line);
  }
  return out;
}

/** A named or numbered group as an integer; 0 when it did not take part in the match. */
export function num(match: RegExpExecArray | null, group: string | number): number {
  if (!match) return 0;
  const value = typeof group === "number" ? match[group] : match.groups?.[group];
  return value ? Number.parseInt(value, 10) : 0;
}

/** `{kind: n}` of each "N kind" in a summary line; a later count of one kind replaces an earlier one. */
export function wordCounts(text: string, kinds: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(kinds)) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[2], Number.parseInt(m[1], 10));
  }
  return out;
}

/** Python's `str.strip(chars)` for one character. */
export function stripChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start += 1;
  while (end > start && s[end - 1] === ch) end -= 1;
  return s.slice(start, end);
}
