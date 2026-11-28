// @effect-diagnostics nodeBuiltinImport:off - Remote command execution built on `@t3tools/ssh/command`.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  controlMasterArgs,
  findLiveControlPath,
  resolveSshTarget,
  runSshCommand,
  shellSingleQuote,
} from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";

import { isValidSshAlias } from "./ciHosts.ts";
import type { ProcessResult } from "./types.ts";

export interface RemoteCommandOptions {
  readonly stdin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly useControlMaster?: boolean | undefined;
}

/** Executes one POSIX bash script on a remote SSH alias. Non-zero exit resolves with `exitCode`. */
export type RemoteCommandRunner = (
  sshAlias: string,
  bashScript: string,
  options?: RemoteCommandOptions,
) => Promise<ProcessResult>;

/** Builds the remote `bash -c '<script>' _ <quoted args...>` command line using `shellSingleQuote`. */
export function buildRemoteBashCommand(
  bashScript: string,
  extraArgs: ReadonlyArray<string> = [],
): string {
  const parts = ["bash", "-c", shellSingleQuote(bashScript)];
  if (extraArgs.length > 0) {
    parts.push("_", ...extraArgs.map(shellSingleQuote));
  }
  return parts.join(" ");
}

/**
 * Default remote runner reusing `@t3tools/ssh/command` (`resolveSshTarget`, `findLiveControlPath`,
 * `controlMasterArgs`, `runSshCommand`, `shellSingleQuote`).
 */
export const sshRemoteCommandRunner: RemoteCommandRunner = async (
  sshAlias,
  bashScript,
  options = {},
) => {
  if (!isValidSshAlias(sshAlias)) {
    return { exitCode: 2, stdout: "", stderr: `Invalid SSH host alias: ${sshAlias}` };
  }
  const remoteCmd = buildRemoteBashCommand(bashScript, options.extraArgs);
  const program = Effect.gen(function* () {
    const target = yield* resolveSshTarget(sshAlias);
    const controlPath =
      options.useControlMaster !== false ? yield* findLiveControlPath(target) : null;
    const preHostArgs = controlPath ? controlMasterArgs(controlPath) : [];
    const res = yield* runSshCommand(target, {
      preHostArgs,
      remoteCommandArgs: [remoteCmd],
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      batchMode: "yes",
      // A failed CI step's whole output is its record: the challenge and the failure excerpt read it.
      keepFullErrorOutput: true,
    });
    return { exitCode: 0, stdout: res.stdout, stderr: res.stderr } satisfies ProcessResult;
  }).pipe(
    Effect.catch((err) => {
      const rec = err as {
        readonly exitCode?: number | null | undefined;
        readonly stdout?: string | undefined;
        readonly stderr?: string | undefined;
        readonly message?: string | undefined;
      };
      return Effect.succeed<ProcessResult>({
        exitCode: typeof rec.exitCode === "number" ? rec.exitCode : 255,
        stdout: rec.stdout ?? "",
        stderr: rec.stderr || rec.message || String(err),
      });
    }),
    Effect.provide(NodeServices.layer),
  );
  return Effect.runPromise(program);
};
