import {
  agentScopeCommand,
  type AgentScopeCommand,
  type AgentSystemdScope,
} from "@t3tools/shared/AgentScope";

export function managedTerminalCommand(input: {
  readonly recorder: string | null;
  readonly stateDir: string;
  readonly threadId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): AgentScopeCommand {
  const { recorder, stateDir, threadId, command, args } = input;
  if (recorder === null) {
    return {
      command: "/bin/sh",
      args: ["-c", 'printf "%s\\n" "DevLease terminal requires devlease-enroll" >&2; exit 125'],
    };
  }
  return {
    command: recorder,
    args: ["t3-terminal-run", stateDir, threadId, "--", command, ...args],
  };
}

export interface ManagedCodexProfile {
  readonly stateDir: string;
  readonly authFile: string;
  readonly readOnly: boolean;
}

export function managedCodexCommand(
  input: ManagedCodexProfile & {
    readonly threadId: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  },
): AgentScopeCommand {
  return {
    command: "devlease-enroll",
    args: [
      "--codex-program=" + input.command,
      "--codex-auth=" + input.authFile,
      ...(input.readOnly ? ["--read-only-checkout"] : []),
      "t3-run",
      input.stateDir,
      input.threadId,
      "--",
      ...input.args,
    ],
  };
}

export function observedCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly recorder: string | null;
  readonly kind: "terminal" | "thread";
  readonly stateDir: string;
  readonly owner: string | undefined;
  readonly scope: AgentSystemdScope;
}): AgentScopeCommand {
  const { command, args, recorder, kind, stateDir, owner, scope } = input;
  const launch =
    recorder !== null && owner !== undefined
      ? {
          command: recorder,
          args: ["attest", scope.unit, kind, stateDir, owner, "--", command, ...args],
        }
      : { command, args };
  return { ...agentScopeCommand({ ...launch, scope }), unit: scope.unit };
}
