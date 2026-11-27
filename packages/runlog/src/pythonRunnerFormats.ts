/** Python test-runner parsers: pytest and the standard library's unittest. */
import { block, Found, stripChar, wordCounts } from "./runlogFound.ts";

const PYTEST_END = /^=*\s*(\d+ [\w ]+?(?:, \d+ [\w ]+?)*) in [\d.]+s(?: \([\d:]+\))?\s*=*$/;
const PYTEST_FAILED = /^(?:FAILED|ERROR) (\S+)(?: - .*)?$/;
const PYTEST_HEAD = /^_{3,} (.+?) _{3,}$/;
const PYTEST_WORDS = /(\d+) (\w+)(?:,|$)/g;

export function pytest(lines: ReadonlyArray<string>): Found | null {
  let f: Found | null = null;
  for (const line of lines) {
    const m = PYTEST_END.exec(line);
    if (!m || !/\d+ (passed|failed|error)/.test(m[1] ?? "")) continue;
    f ??= new Found("pytest");
    const c = wordCounts(m[1] ?? "", PYTEST_WORDS);
    f.passed += c.get("passed") ?? 0;
    f.failed += (c.get("failed") ?? 0) + (c.get("errors") ?? 0) + (c.get("error") ?? 0);
    f.skipped += (c.get("skipped") ?? 0) + (c.get("xfailed") ?? 0);
  }
  if (f === null) return null;
  lines.forEach((line, i) => {
    const m = PYTEST_FAILED.exec(line);
    if (m) f.failAt(i, m[1] ?? "");
  });
  const head = lines.findIndex((s) => PYTEST_HEAD.test(s));
  if (head >= 0) {
    f.detailAt(
      head,
      block(lines, head, (s) => PYTEST_HEAD.test(s) || s.startsWith("====")),
    );
  }
  return f;
}

const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s$/;
const UNITTEST_END = /^(OK|FAILED)(?: \((.*)\))?$/;
const UNITTEST_CASE = /^(?:FAIL|ERROR): (\S+) \((.+)\)/;

export function unittest(lines: ReadonlyArray<string>): Found | null {
  let f: Found | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = UNITTEST_RAN.exec(lines[i] ?? "");
    if (!m) continue;
    let end: RegExpExecArray | null = null;
    for (const s of lines.slice(i + 1, i + 4)) {
      end = UNITTEST_END.exec(s);
      if (end) break;
    }
    if (!end) continue;
    f ??= new Found("unittest");
    const c = new Map<string, number>();
    for (const kv of (end[2] ?? "").matchAll(/(\w+)=(\d+)/g)) {
      c.set(kv[1] ?? "", Number.parseInt(kv[2] ?? "0", 10));
    }
    const bad = (c.get("failures") ?? 0) + (c.get("errors") ?? 0);
    f.failed += bad;
    f.skipped += (c.get("skipped") ?? 0) + (c.get("expected failures") ?? 0);
    f.passed += Number.parseInt(m[1] ?? "0", 10) - bad - (c.get("skipped") ?? 0);
  }
  if (f === null) return null;
  const found: Found = f;
  const stop = (s: string) => s.startsWith("=".repeat(20)) || UNITTEST_RAN.test(s);
  lines.forEach((line, i) => {
    const m = UNITTEST_CASE.exec(line);
    if (!m) return;
    // "test_x (mod.Class.test_x)" from Python 3.11, "test_x (mod.Class)" before.
    const test = m[1] ?? "";
    const where = m[2] ?? "";
    found.failAt(i, where.endsWith(`.${test}`) ? where : `${where}.${test}`);
    found.detailAt(
      i,
      block(lines, i, stop).filter((s) => stripChar(s, "-") !== ""),
    );
  });
  return found;
}
