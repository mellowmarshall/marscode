import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  buildHostGuardApproval,
  type ChildThreadHostGuardApproval,
} from "../../lib/hostGuardApprovals";
import type { TimelineRowSharedState } from "./timelineRowContext";
import { TimelineRowCtx } from "./timelineRowContext";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

const state = vi.hoisted(() => ({
  respond: vi.fn(),
  childApprovalsAtom: null as unknown,
}));

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/threads", () => ({
  childThreadApprovalsAtom: () => state.childApprovalsAtom,
  threadEnvironment: { respondToApproval: {} },
}));

import { ChildThreadApprovals } from "./ChildThreadApprovals";

it("renders a host-guard approval in TimelinePendingApprovalRow and dispatches Approve once / Deny", async () => {
  const onRespondToApproval = vi.fn(async () => ({ ok: true }));
  const mapped = buildHostGuardApproval({
    requestId: "t3r_timeline_1",
    guard: "git",
    command: ["git", "push", "--force", "origin", "main"],
    argvSha256: "b".repeat(64),
    cwd: "/data/Dev/repo",
    refusal: "force push refused",
    proposedReason: "Rebased cleanly",
    threadId: "thread-1",
    session: "",
    pid: 100,
    createdAt: "2026-11-23T12:00:00.000Z",
    expiresAt: "2026-11-23T12:05:00.000Z",
  });

  const sharedState = {
    respondingRequestIds: [] as ReadonlyArray<RuntimeRequestId>,
    canOperateThread: true,
    onRespondToApproval,
  } as unknown as TimelineRowSharedState;

  await using screen = await render(
    <TimelineRowCtx value={sharedState}>
      <TimelinePendingApprovalRow approval={mapped.approval} />
    </TimelineRowCtx>,
  );

  await expect.element(screen.getByText("git push --force origin main")).toBeInTheDocument();
  await expect.element(screen.getByText("Host guard (git) · /data/Dev/repo")).toBeInTheDocument();
  await expect.element(screen.getByText("Rebased cleanly")).toBeInTheDocument();

  await screen.getByRole("button", { name: "Approve once", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenCalledWith(mapped.requestId, "accept");

  await screen.getByRole("button", { name: "Deny", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenCalledWith(mapped.requestId, "decline");
});

it("renders host-guard child thread approvals, surfaces resolution errors, and clears on retry", async () => {
  const onResolveHostGuard = vi
    .fn()
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Host offline"))))
    .mockResolvedValueOnce(AsyncResult.success({ resolved: true, grantId: "t3g_ok" }));
  state.childApprovalsAtom = Atom.make([]);

  const thread = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("parent-1"),
  };
  const entry = buildHostGuardApproval({
    requestId: "t3r_child_1",
    guard: "rm",
    command: ["rm", "-rf", "/tmp/work"],
    argvSha256: "c".repeat(64),
    cwd: "/tmp",
    refusal: "destructive delete",
    proposedReason: "",
    threadId: "child-1",
    session: "",
    pid: 200,
    createdAt: "2026-11-23T12:00:00.000Z",
    expiresAt: "2026-11-23T12:05:00.000Z",
  });
  const childApprovals: ReadonlyArray<ChildThreadHostGuardApproval> = [
    {
      childThreadId: ThreadId.make("child-1"),
      childTitle: "Subagent task",
      entry,
    },
  ];

  await using screen = await render(
    <ChildThreadApprovals
      threadRef={thread}
      hostGuardApprovals={childApprovals}
      onResolveHostGuard={onResolveHostGuard}
    />,
  );

  await expect.element(screen.getByText("rm -rf /tmp/work")).toBeInTheDocument();
  await expect.element(screen.getByText("Host guard (rm) · /tmp")).toBeInTheDocument();

  await screen.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Host offline");

  await screen.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(onResolveHostGuard).toHaveBeenLastCalledWith({
    environmentId: EnvironmentId.make("env-1"),
    input: {
      requestId: "t3r_child_1",
      decision: "approve",
    },
  });
});
