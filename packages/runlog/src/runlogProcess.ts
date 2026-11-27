// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * Runs the command with its stdout and stderr in the log, in its own process
 * group: a signal to runlog reaches the whole suite, grandchildren too,
 * whether or not the runner passes it on. The result is the command's exit
 * code, or 128+N when signal N ended it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

const FORWARDED: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];
/** A log larger than this is summarised from its tail: runner summaries end it. */
export const TAIL_BYTES = 50 * 1024 * 1024;
const CHUNK = 1 << 20;

/** 128 + the signal's number, as a shell reports it. */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (NodeOS.constants.signals[signal] ?? 0);
}

/** Runs `cmd` writing to `fd`, which it closes; resolves to the exit code. */
export function runCommand(cmd: ReadonlyArray<string>, fd: number): Promise<number> {
  const [program = "", ...args] = cmd;
  return new Promise((resolve) => {
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const finish = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      for (const [sig, handler] of handlers) process.off(sig, handler);
      if (note) NodeFS.writeSync(fd, note);
      NodeFS.closeSync(fd);
      resolve(code);
    };
    let child: NodeChildProcess.ChildProcess;
    try {
      // detached: the child leads a new process group.
      child = NodeChildProcess.spawn(program, args, { stdio: ["inherit", fd, fd], detached: true });
    } catch (error) {
      finish(127, `runlog: cannot run ${program}: ${(error as Error).message}\n`);
      return;
    }
    for (const sig of FORWARDED) {
      const handler = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // The group is gone already.
        }
      };
      handlers.set(sig, handler);
      process.on(sig, handler);
    }
    child.once("error", (error) => {
      finish(127, `runlog: cannot run ${program}: ${error.message}\n`);
    });
    child.once("exit", (code, signal) => {
      finish(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
}

export interface LogRead {
  /** The log's last bytes (from a line start), decoded. */
  readonly text: string;
  /** Its whole line count. */
  readonly lines: number;
  /** Whether the text is a tail. */
  readonly cut: boolean;
}

/** Reads the log as a stream: its line count, and its last `cap` bytes from a line start. */
export function readLog(path: string, cap: number = TAIL_BYTES): LogRead {
  const fd = NodeFS.openSync(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let lines = 0;
    let size = 0;
    for (;;) {
      const n = NodeFS.readSync(fd, buf, 0, CHUNK, size);
      if (n === 0) break;
      size += n;
      for (let i = 0; i < n; i += 1) if (buf[i] === 0x0a) lines += 1;
    }
    const start = Math.max(0, size - cap);
    let data = Buffer.alloc(size - start);
    NodeFS.readSync(fd, data, 0, data.length, start);
    const cut = size > cap;
    if (cut) data = data.subarray(data.indexOf(0x0a) + 1);
    return { text: data.toString("utf8"), lines, cut };
  } finally {
    NodeFS.closeSync(fd);
  }
}
