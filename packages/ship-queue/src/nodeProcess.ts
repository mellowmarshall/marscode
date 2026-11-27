// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node child-process runner for the headless CLI's process port.
import * as NodeChildProcess from "node:child_process";

import type { ProcessRunner } from "./types.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const TIMEOUT_EXIT_CODE = 124;

function killProcessTree(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CLI has no Effect runtime.
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to direct child kill when not a process-group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

export const nodeProcessRunner: ProcessRunner = (input) =>
  new Promise((resolve, reject) => {
    const hasTimeout = input.timeoutMs !== undefined && input.timeoutMs > 0;
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CLI has no Effect runtime.
    const useProcessGroup = hasTimeout && process.platform !== "win32";
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.replaceEnv ? { ...input.env } : { ...process.env, ...input.env },
      detached: useProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    if (hasTimeout) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          killProcessTree(child, "SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref();
      }, input.timeoutMs);
      timer.unref();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      const stderrText = Buffer.concat(err).toString("utf8");
      const timeoutNote = timedOut
        ? `${stderrText && !stderrText.endsWith("\n") ? "\n" : ""}ship-queue: process timed out after ${input.timeoutMs}ms\n`
        : "";
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? (signal ? 128 : 1)),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `${stderrText}${timeoutNote}`,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin ?? "");
  });
