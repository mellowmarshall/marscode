// The lines of a failed step's output that the job log keeps: the failure itself, then the tail.

const TAIL_LINES = 40;
const BEFORE = 2;
const AFTER = 12;
/** At most this many lines come from failure matches, so a step that fails everywhere stays short. */
const MATCH_BUDGET = 120;

/**
 * Lines that name a failure in the runners the queue's repos use: vitest and other test runners
 * (`FAIL`, `AssertionError`, `×`, `✗`), TypeScript and lint errors, and a gate's summary block
 * (`check:changed summary`). A miss only costs context; the full output stays in the job's files.
 */
const FAILURE_LINE_RE =
  /\bFAIL(?:ED)?\b|AssertionError|^\s*[×✗]\s|\berror TS\d+|\b(?:Error|ERR!):\s/u;
const SUMMARY_LINE_RE = /\bsummary\b/iu;

/** Inclusive line ranges around each failure line, merged where they touch, within the budget. */
function failureRanges(lines: ReadonlyArray<string>, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let budget = MATCH_BUDGET;
  for (let i = 0; i < end && budget > 0; i += 1) {
    const line = lines[i] ?? "";
    if (!FAILURE_LINE_RE.test(line) && !SUMMARY_LINE_RE.test(line)) continue;
    const from = Math.max(0, i - BEFORE);
    const to = Math.min(end - 1, i + AFTER);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) {
      budget -= Math.max(0, to - last[1]);
      last[1] = Math.max(last[1], to);
    } else {
      budget -= to - from + 1;
      ranges.push([from, to]);
    }
  }
  return ranges;
}

/**
 * The excerpt of a failed step's output for the job log and the FAILED reason's context: every
 * line near a failure line, then the last 40 lines, with a count where lines are left out. Output
 * of 40 lines or fewer comes back whole.
 */
export function failureExcerpt(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TAIL_LINES) return text;
  const tailStart = lines.length - TAIL_LINES;
  const kept: string[] = [];
  let next = 0;
  const gap = (upTo: number) => {
    if (upTo > next)
      kept.push(`... (${upTo - next} lines left out; the step's output file has them)`);
  };
  for (const [from, to] of failureRanges(lines, tailStart)) {
    gap(from);
    kept.push(...lines.slice(from, to + 1));
    next = to + 1;
  }
  gap(tailStart);
  kept.push(...lines.slice(Math.max(next, tailStart)));
  return kept.join("\n");
}
