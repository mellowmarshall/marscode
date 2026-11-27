// @effect-diagnostics nodeBuiltinImport:off - fixture tests read files with node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { duration, report, summarise } from "./runlogSummary.ts";

// fixtures/ holds real runner output (vitest, Playwright, node --test, Maestro,
// pytest, a bash suite, cargo test) cut from real runs, with project names and
// paths replaced by neutral ones.
const FIXTURES = NodeURL.fileURLToPath(new URL("../fixtures/", import.meta.url));

function fixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(FIXTURES, `${name}.txt`), "utf8");
}

function summary(name: string, rc = 1): string[] {
  return report({ rc, seconds: 2.5, logPath: "/runs/x.log", text: fixture(name) });
}

function after(out: string[], heading: string): string[] {
  return out.slice(out.indexOf(heading) + 1);
}

describe("runlog summaries of real runner output", () => {
  it("reads vitest", () => {
    const out = summary("vitest-fail.log");
    expect(out[0]).toBe("runlog: FAIL exit 1 in 2.5s (vitest)");
    expect(out[1]).toBe("tests: 95 passed, 19 failed");
    expect(out).toContain(
      "  tests/order-repository.test.ts > order repository > quietly drops non-cancel changes when a durable cancel exists",
    );
    const detail = after(out, "first failure:");
    expect(detail[1]).toContain(
      "TypeError: Cannot read properties of undefined (reading 'rowCount')",
    );
    expect(detail.length).toBeLessThanOrEqual(20);
  });

  it("reads Playwright", () => {
    const out = summary("playwright-fail.log");
    expect(out[0]).toBe("runlog: FAIL exit 1 in 2.5s (playwright)");
    expect(out[1]).toBe("tests: 1 passed, 1 failed");
    expect(out[3]).toBe(
      "  e2e/tests/calendar-export.spec.ts:26:7 › calendar export › schedule, move, list and cancel an event",
    );
    expect(out.some((s) => s.includes('Expected substring: "STATUS:CANCELLED"'))).toBe(true);
    expect(out.some((s) => s.includes("attachment #"))).toBe(false);
  });

  it("reads node --test TAP", () => {
    const out = summary("node-tap-fail.log");
    expect(out[0]).toBe("runlog: FAIL exit 1 in 2.5s (node-test)");
    expect(out[1]).toBe("tests: 9 passed, 1 failed");
    expect(out[3]).toBe(
      "  publishes the one export instance that passed materialization and scans",
    );
    expect(out.some((s) => s.includes("exportCount: 2"))).toBe(true);
  });

  it("reads Maestro flows", () => {
    const out = summary("maestro-fail.log");
    expect(out.slice(1, 4)).toEqual([
      "tests: 0 passed, 1 failed",
      "failing:",
      "  Release diagnostics support proof",
    ]);
    expect(out.at(-1)).toBe('  Assertion is false: "Profile tab" is visible');
    expect(summary("maestro-pass.log", 0)).toEqual([
      "runlog: PASS exit 0 in 2.5s (maestro)",
      "tests: 1 passed, 0 failed",
      "log: /runs/x.log",
    ]);
  });

  it("reads quiet pytest and pytest with subtests", () => {
    expect(summary("pytest-pass.log", 0)).toEqual([
      "runlog: PASS exit 0 in 2.5s (pytest)",
      "tests: 37 passed, 0 failed",
      "log: /runs/x.log",
    ]);
    expect(summary("pytest-subtests-pass.log", 0).slice(0, 2)).toEqual([
      "runlog: PASS exit 0 in 2.5s (pytest)",
      "tests: 37 passed, 0 failed",
    ]);
  });

  it("reads a bash suite and caps the names at 10", () => {
    const out = summary("bash-test-fail.log");
    expect(out[0]).toBe("runlog: FAIL exit 1 in 2.5s (bash-test)");
    expect(out[1]).toBe("tests: 28 passed, 12 failed");
    expect(out[3]).toBe("  submit returns a job and prints the one watch command");
    expect(out[13]).toBe("  ... 2 more in the log");
    expect(out.indexOf("log: /runs/x.log") + 1).toBeLessThanOrEqual(15);
    expect(after(out, "first failure:")[0]).toBe(
      "  FAIL submit returns a job and prints the one watch command",
    );
  });

  it("sums every format a ci-local runs", () => {
    const text = ["vitest-fail.log", "pytest-pass.log", "bash-test-fail.log"]
      .map(fixture)
      .join("\n");
    const out = report({ rc: 1, seconds: 1, logPath: "/x", text });
    expect(out[0]).toBe("runlog: FAIL exit 1 in 1.0s (vitest+pytest+bash-test)");
    expect(out[1]).toBe("tests: 160 passed, 31 failed");
    // The earliest failure in the log is the detail: vitest's.
    expect(after(out, "first failure:")[0]).toContain("order repository");
  });

  it("sums every cargo binary, ignored tests as skipped", () => {
    expect(summary("cargo-pass.log", 0)).toEqual([
      "runlog: PASS exit 0 in 2.5s (cargo-test)",
      "tests: 5 passed, 0 failed, 1 skipped",
      "log: /runs/x.log",
    ]);
  });

  it("names cargo failures and shows the first stdout block", () => {
    const out = summary("cargo-fail.log", 101);
    expect(out.slice(0, 6)).toEqual([
      "runlog: FAIL exit 101 in 2.5s (cargo-test)",
      "tests: 3 passed, 2 failed, 1 skipped",
      "failing:",
      "  integration_bad",
      "  integration_panics",
      "log: /runs/x.log",
    ]);
    const detail = after(out, "first failure:");
    expect(detail[0]).toBe("  ---- integration_bad stdout ----");
    expect(detail).toContain("  assertion `left == right` failed: one plus one");
    expect(detail.some((s) => s.includes("integration_panics"))).toBe(false);
  });

  it("caps many cargo failures across binaries", () => {
    const out = summary("cargo-many-fail.log", 101);
    expect(out[1]).toBe("tests: 3 passed, 13 failed, 1 skipped");
    expect(out.slice(2, 5)).toEqual(["failing:", "  tests::adds_zero", "  many_bad_01"]);
    expect(out[13]).toBe("  ... 3 more in the log");
    expect(out[14]).toBe("log: /runs/x.log");
    expect(out[16]).toBe("  ---- tests::adds_zero stdout ----");
  });

  it("names the crate of a cargo compile error and shows rustc's first error", () => {
    const out = summary("cargo-compile-error.log", 101);
    expect(out.slice(0, 5)).toEqual([
      "runlog: FAIL exit 101 in 2.5s (cargo-test)",
      "tests: 0 passed, 0 failed",
      "failing:",
      '  could not compile demo (test "integration")',
      "log: /runs/x.log",
    ]);
    const detail = after(out, "first failure:");
    expect(detail[0]).toBe("  error[E0308]: mismatched types");
    expect(detail).toContain("   --> tests/integration.rs:1:44");
    expect(detail.some((s) => s.includes("E0425"))).toBe(false);
  });

  it("names a should-panic failure once", () => {
    const out = summary("cargo-should-panic.log", 101);
    expect(out.slice(1, 5)).toEqual([
      "tests: 2 passed, 2 failed",
      "failing:",
      "  tests::bad",
      "  tests::nopanic",
    ]);
    expect(out[5]).toBe("log: /runs/x.log");
    expect(out[7]).toBe("  ---- tests::bad stdout ----");
  });

  it("takes a --nocapture panic as the first failure", () => {
    const out = summary("cargo-nocapture.log", 101);
    expect(out.slice(1, 5)).toEqual([
      "tests: 2 passed, 2 failed",
      "failing:",
      "  tests::bad",
      "  tests::nopanic",
    ]);
    const detail = after(out, "first failure:");
    expect(detail[0]?.startsWith("  thread 'tests::bad' (")).toBe(true);
    expect(detail).toContain("  assertion `left == right` failed: bad sum");
    expect(detail.some((s) => s.includes("FAILED") || s.includes("panics_as_expected"))).toBe(
      false,
    );
  });

  it("keeps every format's summary head within 15 lines", () => {
    const names = NodeFS.readdirSync(FIXTURES)
      .filter((n) => n.endsWith(".log.txt"))
      .map((n) => n.replace(/\.txt$/, ""))
      .sort();
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      for (const rc of [0, 1]) {
        const out = summary(name, rc);
        expect(out, name).not.toContain("output not recognised; its last lines:");
        let head = out.findIndex(
          (s) =>
            s === "first failure:" || s === "no failure detail found; the output's last lines:",
        );
        if (head < 0) head = out.length;
        expect(head, name).toBeLessThanOrEqual(15);
        expect(out[head - 1]?.startsWith("log: "), name).toBe(true);
      }
    }
  });
});

describe("runlog formats on edge input", () => {
  it("strips ANSI codes and CRLF before reading", () => {
    const text =
      "\u001b[32mok   one\u001b[0m\r\n\u001b]0;title\u0007FAIL two\r\nx: 1 passed, 1 failed\r\n";
    const { found } = summarise(text);
    expect(found?.fmt).toBe("bash-test");
    expect(found?.failures).toEqual([[1, "two"]]);
  });

  it("reports an exit of 0 with failed tests as a failure", () => {
    const out = report({
      rc: 0,
      seconds: 1,
      logPath: "/x",
      text: "ok   a\nFAIL b\nx: 1 passed, 1 failed\n",
    });
    expect(out[0]).toBe("runlog: FAIL (exit 0, 1 failed) in 1.0s (bash-test)");
  });

  it("shows the last lines of an unrecognised output, or says there was none", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const out = report({ rc: 3, seconds: 0.5, logPath: "/x", text: `${lines.join("\n")}\n` });
    expect(out[0]).toBe("runlog: FAIL exit 3 in 0.5s");
    expect(out[2]).toBe("output not recognised; its last lines:");
    expect(out.slice(3)).toEqual(lines.slice(-12).map((s) => `  ${s}`));
    expect(report({ rc: 0, seconds: 0, logPath: "/x", text: "\n\n" })).toEqual([
      "runlog: PASS exit 0 in 0.0s",
      "log: /x",
      "(no output)",
    ]);
  });

  it("falls back to the last lines when a failure has no detail", () => {
    const out = report({ rc: 1, seconds: 1, logPath: "/x", text: "x: 3 passed, 0 failed\nboom\n" });
    expect(out.slice(2)).toEqual([
      "log: /x",
      "no failure detail found; the output's last lines:",
      "  x: 3 passed, 0 failed",
      "  boom",
    ]);
  });

  it("omits the duration for a log summarised after the fact", () => {
    expect(report({ rc: 0, seconds: null, logPath: "/x", text: "" })[0]).toBe(
      "runlog: PASS exit 0",
    );
  });

  it("reads go test without -v per package and names a build failure", () => {
    const text =
      "# example.com/m\n./m.go:3:1: syntax error\nFAIL\texample.com/m [build failed]\nok  \texample.com/n\t0.01s\n";
    const out = report({ rc: 1, seconds: 1, logPath: "/x", text });
    expect(out.slice(1, 4)).toEqual([
      "packages: 1 passed, 1 failed",
      "failing:",
      "  example.com/m",
    ]);
    expect(after(out, "first failure:")[0]).toBe("  # example.com/m");
  });

  it("reads jest's Tests: line and its ● case headings", () => {
    const text = [
      "  ● math › adds",
      "    expect(received).toBe(expected)",
      "Tests:       1 failed, 2 skipped, 4 passed, 7 total",
    ].join("\n");
    const { found } = summarise(text);
    expect(found?.fmt).toBe("jest");
    expect([found?.passed, found?.failed, found?.skipped]).toEqual([4, 1, 2]);
    expect(found?.failures).toEqual([[0, "math › adds"]]);
  });

  it("formats durations as runlog does", () => {
    expect(duration(2.5)).toBe("2.5s");
    expect(duration(187)).toBe("3m07s");
    expect(duration(3900)).toBe("1h05m");
  });
});
