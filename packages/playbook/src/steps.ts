// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Runs a repo-declared command with bash in the real checkout, without blocking the caller's event loop.
import * as NodeChildProcess from "node:child_process";

import { withoutGitOverrides } from "./git.ts";

export interface StepRun {
  /** null when the command could not start (bash missing, timeout). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly why: string | null;
}

const STEP_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Run COMMAND with bash in ROOT (async: a long lint must not stall a server that calls it). */
export function runStep(
  root: string,
  command: string,
  extraEnv: Readonly<Record<string, string>> = {},
  timeoutMs = STEP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<StepRun> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", why: "cancelled before it started" });
      return;
    }
    const child = NodeChildProcess.spawn("bash", ["-c", command], {
      cwd: root,
      env: { ...withoutGitOverrides(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let why: string | null = null;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        why = "output exceeded 64 MiB";
        child.kill("SIGKILL");
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      why = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      why = "cancelled";
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, failure: string | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code: why || failure ? null : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        why: why ?? failure,
      });
    };
    child.on("error", (cause) => finish(null, cause.message));
    child.on("close", (code, signal) => finish(code, signal ? `stopped by ${signal}` : null));
  });
}

export function tailLines(run: StepRun, n: number): ReadonlyArray<string> {
  return `${run.stdout}\n${run.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n);
}
