import { ThreadId, type PendingHostGuardRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectDescendantSubagentIds,
  deriveThreadHostGuardApprovals,
  EMPTY_HOST_GUARD_APPROVALS,
  formatSafeCommandArgv,
  isHostGuardApprovalRequestId,
  resolveNavigationThreadId,
  sanitizeApprovalDisplayText,
} from "./hostGuardApprovals";

function makeGuardRequest(
  overrides: Partial<PendingHostGuardRequest> = {},
): PendingHostGuardRequest {
  return {
    requestId: "t3r_abc123",
    guard: "git",
    command: ["git", "push", "--force", "origin", "feat/branch"],
    argvSha256: "a".repeat(64),
    cwd: "/data/Dev/repo",
    refusal: "force-push blocked",
    proposedReason: "Rebased branch after review",
    threadId: "thread-1",
    session: "",
    pid: 1234,
    createdAt: "2026-11-23T12:00:00.000Z",
    expiresAt: "2026-11-23T12:05:00.000Z",
    ...overrides,
  };
}

describe("hostGuardApprovals", () => {
  it("formats full sanitized command argv without truncation and strips bidi/control chars", () => {
    expect(formatSafeCommandArgv(["git", "push", "--force"])).toBe("git push --force");
    expect(formatSafeCommandArgv(["echo", "a b", "it's", ""])).toBe("echo 'a b' 'it'\\''s' ''");
    expect(formatSafeCommandArgv(["cmd", "\u202eevil\u2066\u0007\u{e0001}"])).toBe(
      "cmd '?evil???'",
    );
    expect(sanitizeApprovalDisplayText("  hello\u202e\nworld  ", 50)).toBe("hello world");
    expect(isHostGuardApprovalRequestId("host-guard:t3r_1")).toBe(true);
    expect(isHostGuardApprovalRequestId("runtime:1")).toBe(false);
  });

  it("derives thread-matched approvals and skips mismatched or expired requests", () => {
    const nowMs = Date.parse("2026-11-23T12:01:00.000Z");
    const active = makeGuardRequest({ requestId: "t3r_live", threadId: "thread-1" });
    const otherThread = makeGuardRequest({ requestId: "t3r_other", threadId: "thread-2" });
    const expired = makeGuardRequest({
      requestId: "t3r_exp",
      threadId: "thread-1",
      expiresAt: "2026-11-23T12:00:30.000Z",
    });

    expect(
      deriveThreadHostGuardApprovals({
        threadId: ThreadId.make("thread-3"),
        pending: [active, otherThread, expired],
        nowMs,
      }),
    ).toBe(EMPTY_HOST_GUARD_APPROVALS);

    const matched = deriveThreadHostGuardApprovals({
      threadId: ThreadId.make("thread-1"),
      pending: [active, otherThread, expired],
      nowMs,
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.requestId).toBe("host-guard:t3r_live");
    expect(matched[0]!.approval).toMatchObject({
      requestKind: "command",
      detail: "git push --force origin feat/branch",
      appName: "Host guard (git) · /data/Dev/repo",
      reason: "Rebased branch after review",
      responseCapability: "live",
      supportsFeedback: false,
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Approve once" },
      ],
    });
  });

  it("collects active descendant subagent ids and resolves top navigable ancestor thread", () => {
    const root = ThreadId.make("root");
    const child = ThreadId.make("child");
    const grandchild = ThreadId.make("grandchild");
    const archivedChild = ThreadId.make("archived");
    const deletedChild = ThreadId.make("deleted");
    const forkChild = ThreadId.make("fork");

    const threads = [
      {
        id: root,
        title: "Root",
        deletedAt: null,
        archivedAt: null,
        lineage: { parentThreadId: null, relationshipToParent: null },
      },
      {
        id: child,
        title: "Child",
        deletedAt: null,
        archivedAt: null,
        lineage: { parentThreadId: root, relationshipToParent: "subagent" },
      },
      {
        id: grandchild,
        title: "Grandchild",
        deletedAt: null,
        archivedAt: null,
        lineage: { parentThreadId: child, relationshipToParent: "subagent" },
      },
      {
        id: archivedChild,
        title: "Archived",
        deletedAt: null,
        archivedAt: "2026-11-23T12:00:00.000Z",
        lineage: { parentThreadId: root, relationshipToParent: "subagent" },
      },
      {
        id: deletedChild,
        title: "Deleted",
        deletedAt: "2026-11-23T12:00:00.000Z",
        archivedAt: null,
        lineage: { parentThreadId: root, relationshipToParent: "subagent" },
      },
      {
        id: forkChild,
        title: "Fork",
        deletedAt: null,
        archivedAt: null,
        lineage: { parentThreadId: root, relationshipToParent: "fork" },
      },
    ];

    expect([...collectDescendantSubagentIds(threads, root)]).toEqual([child, grandchild]);
    expect(resolveNavigationThreadId(threads, threads[2]!)).toBe(root);
    expect(resolveNavigationThreadId(threads, threads[5]!)).toBe(forkChild);
  });
});
