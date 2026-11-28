// @effect-diagnostics nodeBuiltinImport:off - Host-guard override engine with terminal fast-path and @t3tools/guard-protocol broker integration.
import { inspectWorktreeBundle } from "@t3tools/guard-protocol/bundle-inspect";
import {
  peekGuardGrant,
  requestGuardGrant,
  resolveGuardSocketPath,
  useGuardGrant,
} from "@t3tools/guard-protocol/client";

import { redactGuardCommand } from "@t3tools/guard-protocol/command-redact";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { recordBrokerGrant, writeOverrideRecord, writeRefusalRecord } from "./overrideLog.ts";
import { overridePlanFile, requestPlanGrant } from "./overridePlan.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import {
  hasControllingTty,
  hasTerminalAncestor,
  isSystemdUserService,
  resolveCallerIdentity,
} from "./procIdentity.ts";
import { resolveT3ServerPid, resolveT3ThreadId } from "./t3ServerTrust.ts";

const OVERRIDE_ENV = "HOST_GUARD_OVERRIDE";
const MIN_OVERRIDE_CHARS = 12;
const MIN_OVERRIDE_WORDS = 3;

export interface OverrideRuntime {
  readonly config: HostGuardsConfig;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly procFs?: ProcFsReader | undefined;
  readonly now?: (() => Date) | undefined;
  readonly writeErr?: ((line: string) => void) | undefined;
  /** Programmatic DI for unit tests only; production CLI never sets these. */
  readonly socketPath?: string | undefined;
  readonly allowTestOverride?: boolean | undefined;
  readonly allowEnvThreadId?: boolean | undefined;
  readonly testMode?: boolean | undefined;
}

export interface OverrideState {
  lastDeniedInProc: boolean;
}

export function createOverrideState(): OverrideState {
  return { lastDeniedInProc: false };
}

export function parseOverrideReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[OVERRIDE_ENV]?.trim() ?? "";
  if (value.length < MIN_OVERRIDE_CHARS) return null;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < MIN_OVERRIDE_WORDS) return null;
  return value;
}

function isOverrideMalformed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OVERRIDE_ENV]?.trim() ?? "";
  return raw.length > 0 && parseOverrideReason(env) === null;
}

function resolveSocketForRuntime(runtime: OverrideRuntime): string | null {
  if (runtime.socketPath !== undefined) {
    return runtime.socketPath || null;
  }
  const env = runtime.env ?? process.env;
  return resolveGuardSocketPath(env, { allowTestOverride: runtime.allowTestOverride === true });
}

function hasInteractiveTty(runtime: OverrideRuntime): boolean {
  if (runtime.testMode === true) return true;
  const procFs = runtime.procFs ?? defaultProcFs;
  return (
    hasControllingTty(procFs) &&
    !isSystemdUserService("self", procFs) &&
    hasTerminalAncestor({
      procFs,
      t3ServerPid: resolveT3ServerPid({ procFs }),
    })
  );
}

export function recordRefusal(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly refusal: string;
  },
  runtime: OverrideRuntime,
  state?: OverrideState,
): void {
  const sock = resolveSocketForRuntime(runtime);
  writeRefusalRecord(
    {
      ...input,
      socketAvailable: sock !== null,
      socketPath: sock ?? undefined,
      deniedByOwner: Boolean(state?.lastDeniedInProc),
    },
    runtime,
  );
}

export async function peekPreapprovedGrant(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
  },
  runtime: OverrideRuntime,
): Promise<boolean> {
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const sock = resolveSocketForRuntime(runtime);
  if (!sock) return false;
  const identity = resolveCallerIdentity({
    env,
    testMode: runtime.testMode,
    procFs,
  });
  const threadId = resolveT3ThreadId(env, {
    procFs,
    socketPath: sock,
    allowEnvThreadId: runtime.allowEnvThreadId,
  });
  const safeCommand = redactGuardCommand(input.command);
  const bundle = inspectWorktreeBundle({
    guard: input.guard,
    command: safeCommand,
    cwd: input.cwd,
  });
  return peekGuardGrant({
    guard: input.guard,
    command: safeCommand,
    cwd: input.cwd,
    bundle,
    threadId,
    session: identity.sessionId,
    socketPath: sock,
    env,
    allowTestOverride: runtime.allowTestOverride,
  });
}

export async function requestOverrideGrant(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly refusal: string;
    readonly allowBlocking?: boolean | undefined;
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
  },
  runtime: OverrideRuntime,
  state?: OverrideState,
): Promise<boolean> {
  if (state) state.lastDeniedInProc = false;
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const writeErr = runtime.writeErr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const why = parseOverrideReason(env);
  const planFile = overridePlanFile(env);
  let sock = resolveSocketForRuntime(runtime);

  if (why === null && sock === null) return false;

  const threadId = resolveT3ThreadId(env, {
    procFs,
    socketPath: sock ?? undefined,
    allowEnvThreadId: runtime.allowEnvThreadId,
  });
  const identity = resolveCallerIdentity({
    env,
    testMode: runtime.testMode,
    procFs,
  });

  if (!identity.isAgent && why !== null && hasInteractiveTty(runtime)) {
    return writeOverrideRecord(
      {
        guard: input.guard,
        command: input.command,
        cwd: input.cwd,
        refusal: input.refusal,
        why,
        session: "",
        via: identity.isT3Terminal ? "t3-terminal" : "terminal",
        threadId,
        extra: input.extra,
      },
      runtime,
    );
  }

  if (sock !== null) {
    const safeCommand = redactGuardCommand(input.command);
    const bundle = inspectWorktreeBundle({
      guard: input.guard,
      command: safeCommand,
      cwd: input.cwd,
      summary: why ?? undefined,
    });
    // The guarded command itself is running: this is the one place a once grant is consumed.
    const existing = await useGuardGrant({
      guard: input.guard,
      command: safeCommand,
      cwd: input.cwd,
      bundle,
      threadId,
      session: identity.sessionId,
      socketPath: sock,
      env,
      allowTestOverride: runtime.allowTestOverride,
    });
    if (existing.ok) {
      return recordBrokerGrant(
        existing,
        {
          guard: input.guard,
          command: safeCommand,
          cwd: input.cwd,
          refusal: input.refusal,
          proposedReason: why ?? "",
          session: identity.sessionId,
          threadId,
          extra: input.extra,
        },
        runtime,
      );
    }
    if (existing.errCode === "unreachable" || existing.errCode === "timeout") {
      sock = null;
    } else if (planFile !== null && threadId) {
      const used = await requestPlanGrant({
        planFile,
        guard: input.guard,
        command: input.command,
        cwd: input.cwd,
        refusal: input.refusal,
        allowBlocking: input.allowBlocking !== false,
        threadId,
        session: identity.sessionId,
        socketPath: sock,
        env,
        allowTestOverride: runtime.allowTestOverride,
        writeErr,
      });
      if (!used) return false;
      return recordBrokerGrant(
        used,
        {
          guard: input.guard,
          command: safeCommand,
          cwd: input.cwd,
          refusal: input.refusal,
          proposedReason: used.reason ?? "",
          session: identity.sessionId,
          threadId,
          extra: input.extra,
        },
        runtime,
      );
    } else if (why !== null && threadId) {
      const allowBlocking = input.allowBlocking !== false;
      const reply = await requestGuardGrant({
        guard: input.guard,
        command: safeCommand,
        cwd: input.cwd,
        refusal: input.refusal.split(/\r?\n/, 1)[0] ?? "",
        proposedReason: why,
        bundle,
        wait: allowBlocking,
        consumeExisting: true,
        threadId,
        session: identity.sessionId,
        socketPath: sock,
        env,
        allowTestOverride: runtime.allowTestOverride,
      });
      if (reply.ok && !reply.queued && !reply.alreadyApproved) {
        return recordBrokerGrant(
          reply,
          {
            guard: input.guard,
            command: input.command,
            cwd: input.cwd,
            refusal: input.refusal,
            proposedReason: why,
            session: identity.sessionId,
            threadId,
            extra: input.extra,
          },
          runtime,
        );
      }
      if (!allowBlocking) {
        if (reply.alreadyApproved) return true;
        if (reply.queued || reply.ok) {
          writeErr(
            "host-guard: approval requested in MarsCode; re-run the exact command once approved.",
          );
          return false;
        }
        writeErr(
          `host-guard: refusing ${input.guard} override: ${reply.error || "could not enqueue approval"}.`,
        );
        return false;
      }
      if (reply.denied && state) state.lastDeniedInProc = true;
      if (reply.error || reply.denied) {
        writeErr(
          `host-guard: refusing ${input.guard} override: ${reply.error || "denied by owner"}.`,
        );
      }
      return false;
    }
  }

  if (why === null) return false;
  if (sock !== null && threadId) {
    writeErr(
      `host-guard: refusing ${input.guard} override: agent sessions cannot self-grant overrides; ` +
        "request owner approval in MarsCode or run this command in the embedded terminal.",
    );
  } else {
    writeErr(
      `host-guard: refusing ${input.guard} override: agent sessions cannot self-grant overrides; ` +
        "run this command in your interactive terminal.",
    );
  }
  return false;
}

export async function ownerAllowed(
  action: string,
  cwd: string,
  runtime: OverrideRuntime,
  options?: {
    readonly command?: ReadonlyArray<string> | undefined;
    readonly testOverride?: boolean | undefined;
    readonly state?: OverrideState | undefined;
  },
): Promise<boolean> {
  if (options?.state) options.state.lastDeniedInProc = false;
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const writeErr = runtime.writeErr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const identity = resolveCallerIdentity({
    env,
    testMode: runtime.testMode === true && options?.testOverride === true,
    procFs,
  });

  if (!identity.isAgent && hasInteractiveTty(runtime)) {
    return true;
  }

  const sock = resolveSocketForRuntime(runtime);
  const threadId = resolveT3ThreadId(env, {
    procFs,
    socketPath: sock ?? undefined,
    allowEnvThreadId: runtime.allowEnvThreadId,
  });
  if (threadId && sock !== null) {
    const cmd = redactGuardCommand(
      options?.command && options.command.length > 0 ? options.command : [action],
    );
    const refusal = `human-only action: ${action}`;
    const existing = await useGuardGrant({
      guard: "owner-check",
      command: cmd,
      cwd,
      threadId,
      session: identity.sessionId,
      socketPath: sock,
      env,
      allowTestOverride: runtime.allowTestOverride,
    });
    if (existing.ok) {
      return recordBrokerGrant(
        existing,
        {
          guard: "owner-check",
          command: cmd,
          cwd,
          refusal,
          proposedReason: `Owner approval requested for ${action}`,
          session: identity.sessionId,
          threadId,
        },
        runtime,
      );
    }
    if (existing.errCode !== "unreachable" && existing.errCode !== "timeout") {
      const reply = await requestGuardGrant({
        guard: "owner-check",
        command: cmd,
        cwd,
        refusal,
        proposedReason: `Owner approval requested for ${action}`,
        threadId,
        session: identity.sessionId,
        socketPath: sock,
        env,
        allowTestOverride: runtime.allowTestOverride,
      });
      if (reply.ok) {
        return recordBrokerGrant(
          reply,
          {
            guard: "owner-check",
            command: cmd,
            cwd,
            refusal,
            proposedReason: `Owner approval requested for ${action}`,
            session: identity.sessionId,
            threadId,
          },
          runtime,
        );
      }
      if (reply.denied && options?.state) options.state.lastDeniedInProc = true;
      writeErr(`host-guard: refusing ${action}: ${reply.error || "owner approval not granted"}.`);
      return false;
    }
  }

  writeErr(
    `host-guard: refusing ${action}: agent sessions cannot self-grant overrides; ` +
      "run this command in your interactive terminal.",
  );
  return false;
}

export function overrideHint(
  cwd: string | undefined,
  runtime: OverrideRuntime,
  state?: OverrideState,
): string {
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const extra = isOverrideMalformed(env)
    ? `\n  (${OVERRIDE_ENV} is set but is not a reason: write why, in words.)`
    : "";
  const identity = resolveCallerIdentity({
    env,
    testMode: runtime.testMode,
    procFs,
  });
  if (identity.isAgent) {
    if (state?.lastDeniedInProc) {
      return `Host guard refusal. Override request was denied by the owner.${extra}`;
    }
    const sock = resolveSocketForRuntime(runtime);
    const threadId = resolveT3ThreadId(env, {
      procFs,
      socketPath: sock ?? undefined,
      allowEnvThreadId: runtime.allowEnvThreadId,
    });
    if (threadId && sock !== null) {
      return (
        `Host guard refusal. Request owner approval via MarsCode input request by running ` +
        `${OVERRIDE_ENV}="<why, in words>" <command> directly (do not hand the owner a terminal block). ` +
        `For several owner-only commands, list them once: HOST_GUARD_OVERRIDE_PLAN=<plan.json> <first command>.${extra}`
      );
    }
    return `Host guard refusal. Contact repository owner to run via terminal if an override is required.${extra}`;
  }
  return (
    `Owner-approved one-off: ${OVERRIDE_ENV}="<why, in words>" <command> ` +
    `(recorded, and printed loudly).${extra}`
  );
}
