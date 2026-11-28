// Text the broker sends into the requesting thread when the owner decides and nobody is waiting.
import { sanitizeText, type PendingGuardRequest } from "@t3tools/guard-protocol/protocol";

export type GuardNoticeDecision = "approved" | "denied" | "expired";

export interface GuardThreadNotice {
  readonly threadId: string;
  readonly requestId: string;
  readonly decision: GuardNoticeDecision;
  readonly text: string;
}

const MAX_COMMAND_CHARS = 300;

function showCommand(argv: ReadonlyArray<string>): string {
  const text = argv
    .map((w) => (/^[A-Za-z0-9_./:@=+,-]+$/.test(w) ? w : JSON.stringify(w)))
    .join(" ");
  return text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}…` : text;
}

export function guardThreadNoticeText(
  req: PendingGuardRequest,
  decision: GuardNoticeDecision,
  reason: string,
): string {
  const cwd = sanitizeText(req.cwd, 260);
  const where = cwd ? ` from ${cwd}` : "";
  if (req.plan && req.plan.length > 0) {
    const list = req.plan.map((e) => `- ${showCommand(e.command)}`).join("\n");
    if (decision === "approved") {
      return `Host guard: the owner approved your command plan (${reason}). Run each command once${where} within 30 minutes:\n${list}`;
    }
    if (decision === "denied") {
      return `Host guard: the owner denied your command plan: ${reason}. Do not run these commands:\n${list}`;
    }
    return `Host guard: your command plan expired without an owner decision. Ask again only if it is still needed:\n${list}`;
  }
  if (req.bundle && req.guard === "ship-queue") {
    const summary = req.bundle.summary || req.bundle.branch;
    if (decision === "approved") {
      return `Host guard: the owner approved the protected diff (${summary}). The ship-queue job resumes on its own; watch it with ship-queue watch.`;
    }
    if (decision === "denied") {
      return `Host guard: the owner denied the protected diff (${summary}): ${reason}.`;
    }
    return `Host guard: the protected-diff approval request (${summary}) expired without an owner decision.`;
  }
  const cmd = showCommand(req.command);
  if (decision === "approved") {
    return `Host guard: the owner approved the ${req.guard} override. Re-run once now${where}: ${cmd}`;
  }
  if (decision === "denied") {
    return `Host guard: the owner denied the ${req.guard} override for ${cmd}: ${reason}. Do not retry it.`;
  }
  return `Host guard: the ${req.guard} override request for ${cmd} expired without an owner decision.`;
}
