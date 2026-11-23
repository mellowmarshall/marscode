import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  RuntimeRequestId,
  type PendingHostGuardRequest,
  type ProviderApprovalOption,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const HOST_GUARD_REQUEST_PREFIX = "host-guard:";
const UNSAFE_SHELL_RE = /[^A-Za-z0-9_./:@=+-]/;
// Strips C0/C1 controls, soft hyphen, Mongolian vowel sep, bidi marks/isolates/overrides,
// invisible formatters (U+200B..U+200F, U+2060..U+2069, U+FEFF), and Unicode Tag chars.
const CONTROL_AND_BIDI_RE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

export interface ThreadHostGuardApproval {
  readonly requestId: RuntimeRequestId;
  readonly request: PendingHostGuardRequest;
  readonly approval: ThreadPendingApproval;
}

export interface ChildThreadHostGuardApproval {
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly entry: ThreadHostGuardApproval;
}

export const EMPTY_HOST_GUARD_APPROVALS: ReadonlyArray<ThreadHostGuardApproval> = [];

export function isHostGuardApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(HOST_GUARD_REQUEST_PREFIX);
}

/**
 * Formats the complete sanitized command argv without truncation — the override grant applies
 * to the entire argv and the native timeline/child cards render it in a scrollable `<pre>`/`<code>`.
 */
export function formatSafeCommandArgv(argv: ReadonlyArray<string>): string {
  return argv
    .map((raw) => {
      const clean = raw.replace(CONTROL_AND_BIDI_RE, "?");
      if (clean === "") return "''";
      if (!UNSAFE_SHELL_RE.test(clean)) return clean;
      return `'${clean.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

export function sanitizeApprovalDisplayText(raw: string | null | undefined, maxLen = 280): string {
  if (!raw) return "";
  const cleaned = raw.replace(CONTROL_AND_BIDI_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

export function isPendingHostGuardActive(
  req: PendingHostGuardRequest,
  nowMs = Date.now(),
): boolean {
  if (!req.threadId) return false;
  const expMs = Date.parse(req.expiresAt);
  return !Number.isFinite(expMs) || expMs > nowMs;
}

export function buildHostGuardApproval(
  req: PendingHostGuardRequest,
  resolve: MessageResolver = m,
): ThreadHostGuardApproval {
  const requestId = RuntimeRequestId.make(`${HOST_GUARD_REQUEST_PREFIX}${req.requestId}`);
  const detail = formatSafeCommandArgv(req.command);
  const guardName = sanitizeApprovalDisplayText(req.guard, 80) || "host-guard";
  const cwd = sanitizeApprovalDisplayText(req.cwd, 120);
  const appName = cwd
    ? resolve(msg("Host guard ({guard}) · {cwd}", { guard: guardName, cwd }))
    : resolve(msg("Host guard ({guard})", { guard: guardName }));
  const reason = sanitizeApprovalDisplayText(req.proposedReason || req.refusal, 240);
  const options: ReadonlyArray<ProviderApprovalOption> = [
    { decision: "decline", label: resolve(msg("Deny")) },
    { decision: "accept", label: resolve(msg("Approve once")) },
  ];
  return {
    requestId,
    request: req,
    approval: {
      requestId,
      requestKind: "command",
      createdAt: req.createdAt,
      detail,
      appName,
      ...(reason ? { reason } : {}),
      options,
      responseCapability: "live",
      supportsFeedback: false,
    },
  };
}

export function deriveThreadHostGuardApprovals(input: {
  readonly threadId: ThreadId | null;
  readonly pending: ReadonlyArray<PendingHostGuardRequest>;
  readonly resolve?: MessageResolver;
  readonly nowMs?: number;
}): ReadonlyArray<ThreadHostGuardApproval> {
  if (!input.threadId || input.pending.length === 0) {
    return EMPTY_HOST_GUARD_APPROVALS;
  }
  const nowMs = input.nowMs ?? Date.now();
  const resolve = input.resolve ?? m;
  const results: ThreadHostGuardApproval[] = [];
  for (const req of input.pending) {
    if (req.threadId !== input.threadId) continue;
    if (!isPendingHostGuardActive(req, nowMs)) continue;
    results.push(buildHostGuardApproval(req, resolve));
  }
  return results.length === 0 ? EMPTY_HOST_GUARD_APPROVALS : results;
}

export interface HostGuardThreadSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly deletedAt: unknown;
  readonly archivedAt: unknown;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: string | null;
  };
}

export function collectDescendantSubagentIds(
  threads: ReadonlyArray<HostGuardThreadSummary>,
  rootThreadId: ThreadId,
): ReadonlySet<ThreadId> {
  const byParent = new Map<ThreadId, ThreadId[]>();
  for (const thread of threads) {
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.lineage.relationshipToParent !== "subagent" ||
      thread.lineage.parentThreadId === null
    ) {
      continue;
    }
    const existing = byParent.get(thread.lineage.parentThreadId);
    if (existing) existing.push(thread.id);
    else byParent.set(thread.lineage.parentThreadId, [thread.id]);
  }
  const out = new Set<ThreadId>();
  const queue: ThreadId[] = [rootThreadId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of byParent.get(current) ?? []) {
      if (!out.has(childId)) {
        out.add(childId);
        queue.push(childId);
      }
    }
  }
  return out;
}

export function resolveNavigationThreadId(
  threads: ReadonlyArray<Pick<HostGuardThreadSummary, "id" | "lineage">>,
  thread: Pick<HostGuardThreadSummary, "id" | "lineage">,
): ThreadId {
  let current = thread;
  const seen = new Set<ThreadId>([current.id]);
  while (
    current.lineage.relationshipToParent === "subagent" &&
    current.lineage.parentThreadId !== null
  ) {
    const parent = threads.find((candidate) => candidate.id === current.lineage.parentThreadId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}
