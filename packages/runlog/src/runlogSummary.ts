/**
 * The summary runlog prints: at most 15 lines (the verdict, the counts, up to
 * 10 failing cases and the log path), then on a failure the first failure's
 * detail (at most 20 lines). An output no parser recognises shows its last 12
 * lines instead.
 */
import { cargoTest } from "./cargoTestFormat.ts";
import { goTest } from "./goTestFormat.ts";
import { nodeTest, playwright, vitest } from "./jsRunnerFormats.ts";
import { pytest, unittest } from "./pythonRunnerFormats.ts";
import { DETAIL_LINES, Found, type RunnerParser } from "./runlogFound.ts";
import { bashTest, maestro } from "./shellRunnerFormats.ts";

export const NAMES_SHOWN = 10;
/** An unrecognised output's last lines: with the verdict, the log path and their heading, the summary stays within 15 lines. */
export const TAIL_SHOWN = 12;
const NAME_CHARS = 160;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export const PARSERS: ReadonlyArray<RunnerParser> = [
  vitest,
  playwright,
  nodeTest,
  pytest,
  unittest,
  goTest,
  maestro,
  bashTest,
  cargoTest,
];

export interface Summary {
  /** Every format found, merged into one; null when none is recognised. */
  readonly found: Found | null;
  /** The log's lines, ANSI codes stripped. */
  readonly lines: ReadonlyArray<string>;
}

/** Splits a log into lines with its ANSI codes stripped. */
export function logLines(text: string): string[] {
  return text.replace(ANSI, "").replaceAll("\r\n", "\n").split("\n");
}

/** Runs every parser over the log and merges what they find. */
export function summarise(text: string): Summary {
  const lines = logLines(text);
  const found = PARSERS.map((p) => p(lines)).filter((f): f is Found => f !== null);
  if (found.length === 0) return { found: null, lines };
  const total = new Found(found.map((f) => f.fmt).join("+"));
  for (const f of found) {
    const u = total.units.get(f.unit) ?? [0, 0, 0];
    total.units.set(f.unit, [u[0] + f.passed, u[1] + f.failed, u[2] + f.skipped]);
    total.passed += f.passed;
    total.failed += f.failed;
    total.skipped += f.skipped;
    total.failures.push(...f.failures);
    if (f.detail) total.detailAt(f.detail.line, f.detail.lines);
  }
  total.failures.sort(([a, an], [b, bn]) => a - b || (an < bn ? -1 : an > bn ? 1 : 0));
  return { found: total, lines };
}

/** "2.5s", "3m07s", "1h05m". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.trunc(seconds);
  const m = Math.trunc(whole / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return m < 60 ? `${m}m${pad(s)}s` : `${Math.trunc(m / 60)}h${pad(m % 60)}m`;
}

function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("");
}

export interface ReportInput {
  /** The command's exit code. */
  readonly rc: number;
  /** How long it ran; null for a log summarised after the fact. */
  readonly seconds: number | null;
  readonly logPath: string;
  readonly text: string;
  /** Appended to the log line (a cut log's line count). */
  readonly logNote?: string;
}

/** The summary's lines. */
export function report(input: ReportInput): string[] {
  const { rc, seconds, logPath, text, logNote = "" } = input;
  const { found, lines } = summarise(text);
  const failed = found ? found.failed : 0;
  // An exit of 0 with failed tests (a runner that does not fail its exit) is still a failure.
  const verdict = rc
    ? `FAIL exit ${rc}`
    : failed
      ? `FAIL (exit 0, ${failed} failed)`
      : "PASS exit 0";
  const took = seconds === null ? "" : ` in ${duration(seconds)}`;
  const out = [`runlog: ${verdict}${took}` + (found ? ` (${found.fmt})` : "")];
  const tail = lines.filter((s) => s.trim() !== "");
  if (found) {
    out.push(
      [...found.units.entries()]
        .map(
          ([unit, [p, f, s]]) => `${unit}: ${p} passed, ${f} failed` + (s ? `, ${s} skipped` : ""),
        )
        .join("; "),
    );
    const names = [...new Set(found.failures.map(([, n]) => n))];
    if (names.length > 0) {
      out.push("failing:");
      for (const n of names.slice(0, NAMES_SHOWN)) out.push(`  ${clip(n, NAME_CHARS)}`);
      if (names.length > NAMES_SHOWN) {
        out.push(`  ... ${names.length - NAMES_SHOWN} more in the log`);
      }
    }
  }
  out.push(`log: ${logPath}${logNote}`);
  if (found && found.detail && (rc !== 0 || found.failed)) {
    out.push("first failure:", ...found.detail.lines.map((s) => `  ${s}`));
  } else if (!found) {
    if (tail.length > 0) {
      out.push(
        "output not recognised; its last lines:",
        ...tail.slice(-TAIL_SHOWN).map((s) => `  ${s}`),
      );
    } else {
      out.push("(no output)");
    }
  } else if (rc !== 0 || failed) {
    out.push(
      "no failure detail found; the output's last lines:",
      ...tail.slice(-DETAIL_LINES).map((s) => `  ${s}`),
    );
  }
  return out;
}
