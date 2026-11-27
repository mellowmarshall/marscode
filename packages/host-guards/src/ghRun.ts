// @effect-diagnostics nodeBuiltinImport:off - Signal-safe `gh-run` executor with guard enforcement, prose stamping, and temp cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { cleanupGhStampTempDirs, prepareStampedGhArgs } from "./ghAttribution.ts";
import { enforceDirectGuard } from "./hook.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import type { OverrideRuntime } from "./override.ts";
import type { ProcFsReader } from "./procFs.ts";

export interface GhRunIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string | undefined;
  readonly err: (text: string) => void;
  readonly procFs?: ProcFsReader | undefined;
  readonly socketPath?: string | undefined;
  readonly allowEnvThreadId?: boolean | undefined;
  readonly testMode?: boolean | undefined;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const num = NodeOS.constants.signals[signal];
  return typeof num === "number" ? 128 + num : 1;
}

function parseGhRunArgs(
  args: ReadonlyArray<string>,
  fallbackCwd: string,
): {
  readonly realGhOverride: string;
  readonly cwd: string;
  readonly rest: ReadonlyArray<string>;
} {
  let realGhOverride = "";
  let cwd = fallbackCwd;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--real-gh" && i + 1 < args.length) {
      realGhOverride = args[++i]!;
      continue;
    }
    if (a.startsWith("--real-gh=")) {
      realGhOverride = a.slice("--real-gh=".length);
      continue;
    }
    if (a === "--cwd" && i + 1 < args.length) {
      cwd = args[++i]!;
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }
    rest.push(a);
  }
  return { realGhOverride, cwd, rest };
}

export async function runGhSubcommand(
  args: ReadonlyArray<string>,
  config: HostGuardsConfig,
  runtime: OverrideRuntime,
  io: GhRunIo,
): Promise<number> {
  const { realGhOverride, cwd, rest } = parseGhRunArgs(args, io.cwd);
  // The text guard and the stamper may both need stdin; it is read from fd 0 at most once.
  let stdinText = io.stdin;
  let readFd0 = false;
  const readStdin = () => {
    if (stdinText === undefined) {
      readFd0 = true;
      try {
        stdinText = NodeFS.readFileSync(0, "utf8");
      } catch {
        stdinText = "";
      }
    }
    return stdinText;
  };
  const guardCode = await enforceDirectGuard("gh", rest, cwd, runtime, { readStdin });
  if (guardCode !== 0) return guardCode;

  const prepared = prepareStampedGhArgs(rest, cwd, config, {
    env: io.env,
    procFs: io.procFs,
    socketPath: io.socketPath,
    allowEnvThreadId: io.allowEnvThreadId,
    testMode: io.testMode,
    stdin: stdinText,
  });
  const replayStdin = readFd0 && !prepared.consumedStdin;
  const realGh = realGhOverride || config.realGh;

  let child: NodeChildProcess.ChildProcess | null = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupGhStampTempDirs(prepared.tempDirs);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    cleanup();
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig);
      } catch {
        // Child may already have exited.
      }
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await new Promise<number>((resolve) => {
      child = NodeChildProcess.spawn(realGh, [...prepared.args], {
        cwd,
        env: io.env,
        stdio: replayStdin
          ? ["pipe", "inherit", "inherit"]
          : prepared.consumedStdin
            ? ["ignore", "inherit", "inherit"]
            : "inherit",
      });
      if (replayStdin) child.stdin?.end(stdinText);
      child.on("error", (err) => {
        io.err(`gh-run: failed to execute ${realGh}: ${err.message}`);
        resolve(127);
      });
      child.on("close", (code, signal) => {
        if (code !== null) resolve(code);
        else resolve(signalExitCode(signal));
      });
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}
