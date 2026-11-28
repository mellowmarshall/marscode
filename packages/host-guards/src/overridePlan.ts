// @effect-diagnostics nodeBuiltinImport:off - `HOST_GUARD_OVERRIDE_PLAN=<file>`: the first refused command in a plan asks the owner once for the whole plan.
import {
  requestGuardGrant,
  useGuardGrant,
  type GuardGrantReply,
} from "@t3tools/guard-protocol/client";
import { PLAN_GUARD, planContains, readPlanFile } from "@t3tools/guard-protocol/plan";

import { redactGuardCommand } from "@t3tools/guard-protocol/command-redact";

const OVERRIDE_PLAN_ENV = "HOST_GUARD_OVERRIDE_PLAN";

export function overridePlanFile(env: NodeJS.ProcessEnv): string | null {
  return env[OVERRIDE_PLAN_ENV]?.trim() || null;
}

/**
 * Requests owner approval for the plan that lists `command`, then consumes this command's entry.
 * Returns the consuming reply when the command may run now, otherwise `null` (refused or queued).
 */
export async function requestPlanGrant(input: {
  readonly planFile: string;
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly refusal: string;
  readonly allowBlocking: boolean;
  readonly threadId: string;
  readonly session: string;
  readonly socketPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly allowTestOverride?: boolean | undefined;
  readonly writeErr: (line: string) => void;
}): Promise<GuardGrantReply | null> {
  const plan = readPlanFile(input.planFile, input.cwd);
  if (!plan.ok) {
    input.writeErr(`host-guard: refusing ${input.guard}: ${OVERRIDE_PLAN_ENV}: ${plan.error}.`);
    return null;
  }
  const safeCommand = redactGuardCommand(input.command);
  if (!planContains(plan.entries, input.guard, safeCommand)) {
    input.writeErr(
      `host-guard: refusing ${input.guard}: this exact command is not listed for the ${input.guard} guard in ${OVERRIDE_PLAN_ENV}.`,
    );
    return null;
  }
  const common = {
    command: safeCommand,
    cwd: input.cwd,
    threadId: input.threadId,
    session: input.session,
    socketPath: input.socketPath,
    env: input.env,
    allowTestOverride: input.allowTestOverride,
  };
  const reply = await requestGuardGrant({
    ...common,
    guard: PLAN_GUARD,
    plan: plan.entries,
    refusal: input.refusal.split(/\r?\n/, 1)[0] ?? "",
    proposedReason: plan.reason,
    wait: input.allowBlocking,
  });
  if (reply.ok && !reply.queued) {
    const used = await useGuardGrant({ ...common, guard: input.guard });
    if (used.ok) return used;
    input.writeErr(
      `host-guard: refusing ${input.guard}: the plan grant for this command is used up.`,
    );
    return null;
  }
  if (reply.queued) {
    input.writeErr(
      `host-guard: plan approval requested in MarsCode for ${plan.entries.length} commands; ` +
        "your thread is told when the owner decides. Then run each listed command once.",
    );
    return null;
  }
  input.writeErr(
    `host-guard: refusing ${input.guard} plan: ${reply.error || (reply.denied ? "denied by owner" : "not approved")}.`,
  );
  return null;
}
