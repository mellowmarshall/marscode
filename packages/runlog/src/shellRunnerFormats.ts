/** Flow and shell-suite parsers: Maestro, and the `ok …` / `FAIL …` lines of `*.test.sh` suites. */
import { block, Found, num } from "./runlogFound.ts";

const MAESTRO_FLOW = /^\s*\[(Passed|Failed|Skipped)\] (.+?) \((?:\d+[hms] ?)+\)(?: \((.*)\))?\s*$/;
const MAESTRO_SUM = /^\s*(\d+)\/(\d+) Flows? (Passed|Failed)/;

export function maestro(lines: ReadonlyArray<string>): Found | null {
  const flows: Array<[number, RegExpExecArray]> = [];
  lines.forEach((s, i) => {
    const m = MAESTRO_FLOW.exec(s);
    if (m) flows.push([i, m]);
  });
  if (flows.length === 0 && !lines.some((s) => MAESTRO_SUM.test(s))) return null;
  const f = new Found("maestro");
  for (const [i, m] of flows) {
    if (m[1] === "Passed") {
      f.passed += 1;
    } else if (m[1] === "Failed") {
      f.failed += 1;
      f.failAt(i, m[2] ?? "");
      f.detailAt(i, [lines[i] ?? "", ...(m[3] ? [m[3]] : [])]);
    } else {
      f.skipped += 1;
    }
  }
  if (flows.length === 0) {
    for (const line of lines) {
      const m = MAESTRO_SUM.exec(line);
      if (!m) continue;
      const n = Number.parseInt(m[1] ?? "0", 10);
      const total = Number.parseInt(m[2] ?? "0", 10);
      f.failed += m[3] === "Failed" ? n : total - n;
      f.passed += m[3] === "Passed" ? n : total - n;
    }
  }
  return f;
}

// "ok   name" and "FAIL name" / "not ok name": spaces only after the word, so
// go's "ok  \tpkg" and TAP's "ok 3 - name" are not read as these.
const BASH_OK = /^ok {1,4}(?!\d+ - )(\S.*)$/;
const BASH_FAIL = /^(?:FAIL|not ok) {1,4}(?!\d+ - )(\S.*)$/;
const BASH_SUMS: ReadonlyArray<RegExp> = [
  /\b(?<p>\d+) passed, (?<f>\d+) failed(?:, (?<s>\d+) skipped)?(?!.* in [\d.]+s)/,
  /\bpassed (?<p>\d+), failed (?<f>\d+)\b/,
  /:\s(?<p>\d+)\/(?<t>\d+) passed\b/,
];

export function bashTest(lines: ReadonlyArray<string>): Found | null {
  const oks = lines.filter((s) => BASH_OK.test(s)).length;
  const fails: Array<[number, RegExpExecArray]> = [];
  lines.forEach((s, i) => {
    const m = BASH_FAIL.exec(s);
    if (m) fails.push([i, m]);
  });
  const sums: RegExpExecArray[] = [];
  for (const line of lines) {
    for (const rx of BASH_SUMS) {
      const m = rx.exec(line);
      if (m) {
        sums.push(m);
        break;
      }
    }
  }
  if (sums.length === 0 && oks + fails.length === 0) return null;
  const f = new Found("bash-test");
  if (sums.length > 0) {
    for (const m of sums) {
      const p = num(m, "p");
      const groups = m.groups ?? {};
      f.passed += p;
      f.failed += "f" in groups ? num(m, "f") : num(m, "t") - p;
      f.skipped += "s" in groups ? num(m, "s") : 0;
    }
  } else {
    f.passed = oks;
    f.failed = fails.length;
  }
  for (const [i, m] of fails) f.failAt(i, m[1] ?? "");
  const first = fails[0];
  if (first) {
    const [i] = first;
    f.detailAt(
      i,
      block(lines, i, (s) => BASH_OK.test(s) || BASH_FAIL.test(s)),
    );
  }
  return f;
}
