// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * `runlog --ci-suite NAME -- COMMAND`: the one writer of a CI suite's measured
 * begin/end lines (pid = runlog's own, cpu = the reaped children's seconds).
 * Output passes through; the command's own ci-suite:/ci-select: lines are marked.
 */
import * as NodeChildProcess from "node:child_process";

import { clockTicks, reapedChildTicks } from "./reapedChildCpu.ts";
import { cannotRun, signalExitCode } from "./runlogProcess.ts";

/** What a command's line is marked with when it starts as a measured line does. */
export const SUITE_PRINTED = "(the suite printed) ";
const MEASURED_PREFIXES = ["ci-suite:", "ci-select:"];
/** The ASCII whitespace that Python's bytes.lstrip() removes. */
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** A suite name runlog accepts: not blank, and on one line. */
export function validSuiteName(name: string): boolean {
  return name.trim() !== "" && !name.includes("\n");
}

/** The line as runlog passes it on: marked when it starts (after whitespace) as a measured line. */
export function passThroughLine(line: Buffer): Buffer {
  let start = 0;
  while (start < line.length && WHITESPACE.has(line[start] ?? 0)) start += 1;
  const head = line.subarray(start, start + 16).toString("latin1");
  return MEASURED_PREFIXES.some((p) => head.startsWith(p))
    ? Buffer.concat([Buffer.from(SUITE_PRINTED), line])
    : line;
}

export interface CiSuiteIo {
  /** runlog's stdout. */
  readonly out: (chunk: string | Uint8Array) => void;
  /** runlog's stderr. */
  readonly err: (text: string) => void;
  readonly pid: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Runs one measured suite; resolves to the command's exit code (128+N when signal N ended it). */
export function runCiSuite(
  name: string,
  cmd: ReadonlyArray<string>,
  io: CiSuiteIo,
): Promise<number> {
  const [program = "", ...args] = cmd;
  const ticksPerSecond = clockTicks();
  const before = reapedChildTicks();
  return new Promise((resolve) => {
    // The bytes since the last newline, kept as chunks: joined once a newline comes.
    let pending: Buffer[] = [];
    let started = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const why = cannotRun(program, io.env.PATH);
    if (why !== null) {
      io.err(`runlog: cannot run ${program}: ${why}\n`);
      finish(127);
      return;
    }
    // The command's stdout and stderr are one pipe: sh points stderr at
    // stdout and then becomes the command (exec keeps its pid), so the
    // output's order and lines are the command's own.
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", 'exec "$@" 2>&1', "sh", program, ...args],
      {
        cwd: io.cwd,
        env: io.env,
        stdio: ["inherit", "pipe", "inherit"],
      },
    );
    const take = (chunk: Buffer) => {
      let nl = chunk.indexOf(0x0a);
      if (nl < 0) {
        pending.push(chunk);
        return;
      }
      let rest: Buffer = Buffer.concat([...pending, chunk]);
      pending = [];
      nl = rest.indexOf(0x0a);
      while (nl >= 0) {
        io.out(passThroughLine(rest.subarray(0, nl + 1)));
        rest = rest.subarray(nl + 1);
        nl = rest.indexOf(0x0a);
      }
      if (rest.length > 0) pending.push(rest);
    };
    child.once("spawn", () => {
      started = true;
      io.out(`ci-suite: begin ${name} pid=${io.pid} by=runlog\n`);
      child.stdout?.on("data", take);
    });
    child.once("error", (error) => {
      if (started) return;
      io.err(`runlog: cannot run ${program}: ${error.message}\n`);
      finish(127);
    });
    child.once("close", (code, signal) => {
      if (!started) return;
      if (pending.length > 0) io.out(passThroughLine(Buffer.concat(pending)));
      const after = reapedChildTicks();
      const rc = signal ? signalExitCode(signal) : (code ?? 1);
      // Where the reaped children's time cannot be read, cpu= is left out: a
      // measured 0 would claim a suite did no work.
      const cpu =
        before === null || after === null
          ? ""
          : ` cpu=${((after - before) / ticksPerSecond).toFixed(2)}`;
      io.out(`ci-suite: end ${name} ${rc === 0 ? "pass" : "fail"} pid=${io.pid}${cpu} by=runlog\n`);
      finish(rc);
    });
  });
}
