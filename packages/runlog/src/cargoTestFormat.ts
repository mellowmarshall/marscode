/**
 * The `cargo test` parser (Rust's libtest): every binary's `test result:` line
 * summed, ignored tests counted as skipped, the `failures:` lists' names, the
 * first `---- NAME stdout ----` block as the detail; a compile failure names
 * the crate and shows rustc's first error.
 */
import { block, Found } from "./runlogFound.ts";

const CARGO_RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored\b/;
const CARGO_CASE_FAILED = /^test (\S.*?)(?: - should panic)? \.\.\. FAILED$/;
const CARGO_PANIC = /^thread '(.+?)'(?: \(\d+\))? panicked at /;
const CARGO_STDOUT = /^---- (\S.*?) stdout ----$/;
const CARGO_LISTED = /^ {4}(\S.*?)\s*$/;
const CARGO_NO_COMPILE = /^error: could not compile `([^`]+)`(?: \(([^)]*)\))?/;
// rustc's own errors, not cargo's lines about them.
const RUSTC_ERROR =
  /^error(?:\[E\d+\])?: (?!could not compile|test failed|\d+ targets? failed|aborting due to)/;

function startsWithAny(s: string, prefixes: ReadonlyArray<string>): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

export function cargoTest(lines: ReadonlyArray<string>): Found | null {
  const results = lines.map((s) => CARGO_RESULT.exec(s));
  const noCompile: Array<[number, RegExpExecArray]> = [];
  lines.forEach((s, i) => {
    const m = CARGO_NO_COMPILE.exec(s);
    if (m) noCompile.push([i, m]);
  });
  const anyResult = results.some((m) => m !== null);
  if (!anyResult && noCompile.length === 0 && !lines.some((s) => s.startsWith("error[E"))) {
    return null;
  }
  const f = new Found("cargo-test");
  for (const m of results) {
    if (!m) continue;
    f.passed += Number.parseInt(m[1] ?? "0", 10);
    f.failed += Number.parseInt(m[2] ?? "0", 10);
    f.skipped += Number.parseInt(m[3] ?? "0", 10);
  }
  // A binary's "failures:" list names each failing test; the "test NAME ...
  // FAILED" lines name those of a binary whose list is not in the log.
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (line !== "failures:" || !(i + 1 < lines.length && CARGO_LISTED.test(lines[i + 1] ?? ""))) {
      return;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = CARGO_LISTED.exec(lines[j] ?? "");
      if (!m) break;
      seen.add(m[1] ?? "");
      f.failAt(j, m[1] ?? "");
    }
  });
  lines.forEach((line, i) => {
    const m = CARGO_CASE_FAILED.exec(line);
    if (m && !seen.has(m[1] ?? "")) {
      seen.add(m[1] ?? "");
      f.failAt(i, m[1] ?? "");
    }
  });
  const stdout = lines.findIndex((s) => CARGO_STDOUT.test(s));
  if (stdout >= 0) {
    f.detailAt(
      stdout,
      block(
        lines,
        stdout,
        (s) => CARGO_STDOUT.test(s) || s === "failures:" || CARGO_RESULT.test(s),
      ),
    );
  }
  // --nocapture prints a failing test's panic where it ran, with no stdout
  // block: the earlier of the two is the first failure.
  const panic = lines.findIndex((s) => {
    const m = CARGO_PANIC.exec(s);
    return m !== null && seen.has(m[1] ?? "");
  });
  if (panic >= 0) {
    const stop = (s: string) =>
      s === "FAILED" ||
      startsWithAny(s, ["test ", "thread '"]) ||
      s === "failures:" ||
      CARGO_RESULT.test(s);
    f.detailAt(panic, block(lines, panic, stop));
  }
  // A compile failure: no test ran; the crate is named, the first error is the detail.
  for (const [i, m] of noCompile) {
    f.failAt(i, `could not compile ${m[1] ?? ""}` + (m[2] ? ` (${m[2]})` : ""));
  }
  if (f.detail === null && (noCompile.length > 0 || !anyResult)) {
    const first = lines.findIndex((s) => RUSTC_ERROR.test(s));
    if (first >= 0) {
      const stop = (s: string) =>
        startsWithAny(s, ["error", "warning:", "Some errors have", "For more information"]);
      f.detailAt(first, block(lines, first, stop));
    } else if (noCompile.length > 0) {
      const [i] = noCompile[0] ?? [0];
      f.detailAt(i, [lines[i] ?? ""]);
    }
  }
  return f;
}
