// @effect-diagnostics nodeBuiltinImport:off - headless CLI on node:* builtins only.
/**
 * The `runlog` command line: run a test command with its output in a log
 * file and print a short summary, so an agent reads a long suite's log only
 * when it fails (private-repo).
 */
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import { listLogs, openLog, repoName } from "./runlogPaths.ts";
import { readLog, runCommand, TAIL_BYTES } from "./runlogProcess.ts";
import { type Env, logRoot } from "./runlogStorageRoots.ts";
import { report } from "./runlogSummary.ts";

export const USAGE = `usage: runlog [--name NAME] -- COMMAND [ARGS...]
       runlog summarize LOG [--exit CODE]
       runlog list [COUNT]`;

export const HELP = `runlog: run a test command with its output in a log file, print a summary.

    runlog [--name NAME] -- COMMAND [ARGS...]
    runlog summarize LOG [--exit CODE]   summarise a log written earlier
    runlog list [COUNT]                  this repository's latest logs (default 10)

The command's stdout and stderr go to <host root>/runs/<repo>/<name>-<UTC timestamp>.log.
The root is the queue's SHIP_QUEUE_DATA_ROOT in CI, else the host storage
configuration's data root (or source root on a single-drive host). <repo> is the
git repository's name, else the current directory's. runlog prints at most 15
lines: PASS or FAIL, the exit code and duration, the test counts, up to 10
failing case names and the log path; then, on a failure, the first failure's
detail (at most 20 lines). An output it does not recognise shows its last 12
lines instead. Its exit code is the command's (128+N when a signal N ended it).

It reads vitest/jest, Playwright, node --test (TAP and spec), pytest, Python
unittest, go test, cargo test (libtest, and cargo's compile errors), Maestro,
and the ok/FAIL lines and "N passed, M failed" of *.test.sh suites.`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
  readonly env: Env;
  /** The current time in epoch milliseconds. */
  readonly now: () => number;
}

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  // @effect-diagnostics-next-line globalDate:off
  now: () => Date.now(),
};

type Parsed =
  | { readonly kind: "run"; readonly name: string | null; readonly cmd: string[] }
  | { readonly kind: "summarize"; readonly log: string; readonly rc: number }
  | { readonly kind: "list"; readonly count: number }
  | { readonly kind: "help" }
  | { readonly kind: "usage" };

function parseExit(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
}

export function parseArgs(argv: ReadonlyArray<string>): Parsed {
  const [first, ...rest] = argv;
  if (first === "summarize") {
    const [log, flag, value, ...extra] = rest;
    if (!log || extra.length > 0) return { kind: "usage" };
    if (flag === undefined) return { kind: "summarize", log, rc: 0 };
    const rc = flag === "--exit" ? parseExit(value) : null;
    return rc === null ? { kind: "usage" } : { kind: "summarize", log, rc };
  }
  if (first === "list") {
    if (rest.length > 1) return { kind: "usage" };
    const count = rest.length === 0 ? 10 : parseExit(rest[0]);
    return count === null || count < 1 ? { kind: "usage" } : { kind: "list", count };
  }
  let name: string | null = null;
  for (let i = 0; i < argv.length;) {
    const a = argv[i] ?? "";
    if (a === "--") {
      const cmd = argv.slice(i + 1);
      return cmd.length > 0 ? { kind: "run", name, cmd } : { kind: "usage" };
    }
    if (a === "--name" && i + 1 < argv.length) {
      name = argv[i + 1] ?? null;
      i += 2;
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
      i += 1;
    } else if (a === "-h" || a === "--help") {
      return { kind: "help" };
    } else {
      return { kind: "usage" };
    }
  }
  return { kind: "usage" };
}

async function runAndReport(name: string | null, cmd: string[], io: CliIo): Promise<number> {
  const root = logRoot(io.env);
  const { path, fd } = openLog({ root, cwd: io.cwd, name, cmd, nowMs: io.now() });
  const start = NodePerfHooks.performance.now();
  const rc = await runCommand(cmd, fd);
  const seconds = (NodePerfHooks.performance.now() - start) / 1000;
  const { text, lines, cut } = readLog(path);
  const logNote = cut ? ` (${lines} lines; summarised from its last ${TAIL_BYTES >> 20} MB)` : "";
  io.out(`${report({ rc, seconds, logPath: path, text, logNote }).join("\n")}\n`);
  return rc;
}

/** Runs the CLI; resolves to its exit code. */
export async function runRunlogCli(
  argv: ReadonlyArray<string>,
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  const parsed = parseArgs(argv);
  try {
    switch (parsed.kind) {
      case "help":
        io.out(`${HELP}\n`);
        return 0;
      case "usage":
        io.err(`${USAGE}\n`);
        return 2;
      case "summarize": {
        const logPath = NodePath.resolve(io.cwd, parsed.log);
        const { text, lines, cut } = readLog(logPath);
        const logNote = cut
          ? ` (${lines} lines; summarised from its last ${TAIL_BYTES >> 20} MB)`
          : "";
        const out = report({ rc: parsed.rc, seconds: null, logPath, text, logNote });
        io.out(`${out.join("\n")}\n`);
        return out[0]?.startsWith("runlog: PASS") ? 0 : 1;
      }
      case "list": {
        const logs = listLogs(logRoot(io.env), repoName(io.cwd)).slice(0, parsed.count);
        for (const log of logs) io.out(`${log.path}\n`);
        return 0;
      }
      case "run":
        return await runAndReport(parsed.name, parsed.cmd, io);
    }
  } catch (error) {
    io.err(`runlog: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
