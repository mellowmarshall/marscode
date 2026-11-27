/** The `go test` parser: per test with `-v`, per package without it. */
import { block, DETAIL_LINES, Found } from "./runlogFound.ts";

const GO_PKG = /^(ok|FAIL)\s+\t?(\S+)\s+(?:[\d.]+s|\(cached\)|\[[^\]]+\])/;
const GO_FAIL = /^\s*--- FAIL: (\S+)/;
const GO_PASS = /^\s*--- PASS: /;
const GO_SKIP = /^\s*--- SKIP: /;
const GO_NEXT = /^\s*--- (FAIL|PASS|SKIP)|^(FAIL|ok)\b|^=== RUN/;

function words(s: string): string[] {
  const t = s.trim();
  return t === "" ? [] : t.split(/\s+/);
}

export function goTest(lines: ReadonlyArray<string>): Found | null {
  const pkgs: Array<[number, RegExpExecArray]> = [];
  lines.forEach((s, i) => {
    const m = GO_PKG.exec(s);
    if (m) pkgs.push([i, m]);
  });
  if (pkgs.length === 0 && !lines.some((s) => GO_FAIL.test(s))) return null;
  const f = new Found("go-test");
  // -v ("=== RUN" lines) reports every test; without it only failing tests
  // are listed, so the counts are the packages'.
  const verbose = lines.some((s) => s.startsWith("=== RUN")) || pkgs.length === 0;
  const step = verbose ? 1 : 0;
  lines.forEach((line, i) => {
    const m = GO_FAIL.exec(line);
    if (m) {
      const name = m[1] ?? "";
      f.failed += step;
      f.failAt(i, name);
      // -v streams a test's output under its "=== RUN" line, before the
      // "--- FAIL"; without -v it follows the "--- FAIL".
      let run: number | null = null;
      for (let j = i - 1; j > Math.max(-1, i - 2000); j -= 1) {
        const w = words(lines[j] ?? "");
        if (w.length === 3 && w[0] === "===" && w[1] === "RUN" && w[2] === name) {
          run = j;
          break;
        }
      }
      if (run !== null && run + 1 < i) {
        f.detailAt(run, [line, ...lines.slice(run + 1, i)]);
      } else {
        f.detailAt(
          i,
          block(lines, i, (s) => GO_NEXT.test(s)),
        );
      }
    } else if (GO_PASS.test(line)) {
      f.passed += step;
    } else if (GO_SKIP.test(line)) {
      f.skipped += step;
    }
  });
  if (!verbose) {
    const named = f.failures.length > 0;
    for (const [i, m] of pkgs) {
      if (m[1] === "ok") {
        f.passed += 1;
      } else {
        f.failed += 1;
        // A build failure: no test to name, the package then.
        if (!named) f.failAt(i, m[2] ?? "");
      }
    }
    f.unit = "packages";
  }
  if (f.detail === null) {
    // A panic, or a build failure's package header.
    const i = lines.findIndex((s) => s.startsWith("panic:") || s.startsWith("# "));
    if (i >= 0) f.detailAt(i, lines.slice(i, i + DETAIL_LINES));
  }
  return f;
}
