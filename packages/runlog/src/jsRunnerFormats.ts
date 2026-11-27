/**
 * JavaScript test-runner parsers: vitest and jest, Playwright, and `node --test`
 * (TAP and spec reporters). Every occurrence in a log is summed.
 */
import { block, Found, wordCounts } from "./runlogFound.ts";

const VITEST_TESTS = /^\s*Tests\s+(?=.*\(\d+\)\s*$)(.*)$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S.*?\s>\s.*)$/;
const VITEST_CROSS = /^\s+[×✗]\s+(.*?)(?:\s+\d+ms)?$/;
const JEST_TESTS = /^Tests:\s+(.*\d+ total)\s*$/;
const JEST_CASE = /^\s*●\s+(?!Console)(.+›.+)$/;
const COUNT_WORDS = /(\d+) (passed|failed|skipped|todo|pending)/g;

export function vitest(lines: ReadonlyArray<string>): Found | null {
  let f: Found | null = null;
  for (const line of lines) {
    const m = VITEST_TESTS.exec(line) ?? JEST_TESTS.exec(line);
    if (!m) continue;
    f ??= new Found(line.startsWith("Tests:") ? "jest" : "vitest");
    const c = wordCounts(m[1] ?? "", COUNT_WORDS);
    f.passed += c.get("passed") ?? 0;
    f.failed += c.get("failed") ?? 0;
    f.skipped += (c.get("skipped") ?? 0) + (c.get("todo") ?? 0) + (c.get("pending") ?? 0);
  }
  if (f === null) return null;
  let named = false;
  const stop = (s: string) => s.startsWith("⎯") || JEST_CASE.test(s) || VITEST_FAIL.test(s);
  lines.forEach((line, i) => {
    const m = VITEST_FAIL.exec(line) ?? JEST_CASE.exec(line);
    if (!m) return;
    named = true;
    f.failAt(i, m[1] ?? "");
    f.detailAt(i, block(lines, i, stop));
  });
  if (!named) {
    // The run's own per-test marks, when no FAIL block was printed.
    lines.forEach((line, i) => {
      const m = VITEST_CROSS.exec(line);
      if (m) f.failAt(i, m[1] ?? "");
    });
  }
  return f;
}

const PW_RUNNING = /^Running \d+ tests? using \d+ workers?/;
const PW_COUNT = /^\s+(\d+) (passed|failed|flaky|skipped|did not run|interrupted)\b/;
const PW_CASE = /^\s+\d+\) (\S.*›.*?)\s*$/;
const PW_LISTED = /^\s{4}(\S.*›.*?)\s*$/;

export function playwright(lines: ReadonlyArray<string>): Found | null {
  if (!lines.some((s) => PW_RUNNING.test(s))) return null;
  const f = new Found("playwright");
  lines.forEach((line, i) => {
    const m = PW_COUNT.exec(line);
    if (!m) return;
    const n = Number.parseInt(m[1] ?? "0", 10);
    const kind = m[2];
    if (kind === "passed") {
      f.passed += n;
    } else if (kind === "failed" || kind === "flaky" || kind === "interrupted") {
      f.failed += n;
      // The summary lists each failed case under its count line.
      for (let j = i + 1; j < lines.length; j += 1) {
        const c = PW_LISTED.exec(lines[j] ?? "");
        if (!c) break;
        f.failAt(j, c[1] ?? "");
      }
    } else {
      f.skipped += n;
    }
  });
  const stop = (s: string) => PW_CASE.test(s) || s.includes("attachment #") || PW_COUNT.test(s);
  const first = lines.findIndex((s) => PW_CASE.test(s));
  if (first >= 0) f.detailAt(first, block(lines, first, stop));
  return f;
}

const TAP_SUM = /^# (tests|pass|fail|skipped|todo) (\d+)$/;
const TAP_NOT_OK = /^(\s*)not ok \d+ - (.*?)(?:\s+#.*)?$/;
const TAP_RESULT = /^(\s*)(ok|not ok) \d+ - /;
const SPEC_SUM = /^ℹ (tests|pass|fail|skipped|todo) (\d+)$/;
const SPEC_FAIL = /^(\s*)✖ (.*?)(?: \([\d.]+m?s\))?$/;

function tapStop(s: string): boolean {
  const t = s.trimStart();
  return (
    s.trim() === "..." ||
    t.startsWith("ok ") ||
    t.startsWith("not ok ") ||
    t.startsWith("# Subtest")
  );
}

export function nodeTest(lines: ReadonlyArray<string>): Found | null {
  let f: Found | null = null;
  for (const line of lines) {
    const m = TAP_SUM.exec(line) ?? SPEC_SUM.exec(line);
    if (!m) continue;
    f ??= new Found("node-test");
    const n = Number.parseInt(m[2] ?? "0", 10);
    if (m[1] === "pass") f.passed += n;
    else if (m[1] === "fail") f.failed += n;
    else if (m[1] === "skipped" || m[1] === "todo") f.skipped += n;
  }
  if (f === null) return null;
  // A failing subtest fails its parent too, printed after it at a lower
  // indent: name the innermost only.
  const seen = new Set<string>();
  const results: Array<[number, boolean]> = [];
  lines.forEach((line, i) => {
    const r = TAP_RESULT.exec(line);
    if (!r) return;
    const depth = (r[1] ?? "").length;
    const failed = r[2] === "not ok";
    let childFailed = false;
    for (let k = results.length - 1; k >= 0; k -= 1) {
      const [d, bad] = results[k] ?? [0, false];
      if (d <= depth) break;
      childFailed = childFailed || bad;
    }
    results.push([depth, failed]);
    const m = TAP_NOT_OK.exec(line);
    const name = m?.[2] ?? "";
    if (failed && m && !childFailed && !seen.has(name)) {
      seen.add(name);
      f.failAt(i, name);
      f.detailAt(i, block(lines, i, tapStop));
    }
  });
  if (f.failures.length === 0) {
    const start = lines.findIndex((s) => s.startsWith("✖ failing tests:"));
    for (let i = start >= 0 ? start + 1 : lines.length; i < lines.length; i += 1) {
      const m = SPEC_FAIL.exec(lines[i] ?? "");
      const name = m?.[2] ?? "";
      if (m && !seen.has(name)) {
        seen.add(name);
        f.failAt(i, name);
        f.detailAt(
          i,
          block(lines, i, (s) => SPEC_FAIL.test(s)),
        );
      }
    }
  }
  return f;
}
