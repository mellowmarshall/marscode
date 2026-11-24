import "~/index.css";

import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ShipQueueDepRepo,
  type ShipQueueJob,
  type ShipQueueSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  buildShipQueueDepApproval,
  type ChildThreadShipQueueDepApproval,
} from "../../lib/shipQueueApprovals";
import { TooltipProvider } from "../ui/tooltip";
import type { TimelineRowSharedState } from "./timelineRowContext";
import { TimelineRowCtx } from "./timelineRowContext";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

const state = vi.hoisted(() => ({
  nowIso: "2026-11-23T18:00:00.000Z",
  nowMs: Date.parse("2026-11-23T18:00:00.000Z"),
  navigate: vi.fn(),
  cancelCmd: vi.fn(),
  canOperate: true,
  snap: {
    available: true,
    daemonRunning: true,
    daemonPid: 1234,
    openCount: 1,
    totalCount: 1,
    jobs: [] as ShipQueueJob[],
    deps: [] as ShipQueueDepRepo[],
  } as ShipQueueSnapshot,
  threadJobs: [] as ShipQueueJob[],
  childApprovalsAtom: null as unknown,
}));

vi.mock("../../hooks/useNowSecond", () => ({
  useNowSecond: () => state.nowMs,
}));

vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => state.nowIso,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  return {
    ...actual,
    useEnvironmentScope: () => state.canOperate,
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.cancelCmd,
}));

vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      cancelShipQueueJob: {},
    },
  };
});

vi.mock("../../state/shipQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/shipQueue")>();
  return {
    ...actual,
    useShipQueueSnapshot: () => state.snap,
    useThreadShipJobs: () => state.threadJobs,
  };
});

vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/threads")>();
  return {
    ...actual,
    childThreadApprovalsAtom: () => state.childApprovalsAtom,
    threadEnvironment: {
      ...actual.threadEnvironment,
      respondToApproval: {},
    },
  };
});

import { ChildThreadApprovals } from "./ChildThreadApprovals";
import { ThreadShipQueuePanel } from "./ThreadShipQueuePanel";

const envId = EnvironmentId.make("env-sq-1");
const threadId = ThreadId.make("thread-sq-1");
const FIXED_NOW_MS = Date.parse("2026-11-23T18:00:00.000Z");
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

function freshHold(overrides: Partial<ShipQueueDepRepo> = {}): ShipQueueDepRepo {
  return {
    repo: "devtools",
    reportId: "devtools:r_42",
    status: "pending",
    scannedAt: FIXED_NOW_SEC - 60,
    active: true,
    holding: true,
    pendingCount: 1,
    waitingCount: 0,
    heldCount: 1,
    failedCount: 0,
    attemptId: null,
    attemptStatus: null,
    decisionKind: null,
    decisionUntil: null,
    error: null,
    updates: [
      {
        packageFile: "package.json",
        depName: "effect",
        currentValue: "4.0.0-beta.40",
        newValue: "4.0.0-beta.47",
        releaseTimestamp: null,
      },
    ],
    ...overrides,
  };
}

describe("ThreadShipQueuePanel & dep approval integration", () => {
  it("renders ship-queue dependency hold in TimelinePendingApprovalRow and dispatches Approve / Reject (24h)", async () => {
    const onRespondToApproval = vi.fn(async () => ({ ok: true }));
    const built = buildShipQueueDepApproval({
      hold: freshHold(),
      nowMs: FIXED_NOW_MS,
    });
    const share = {
      respondingRequestIds: [] as ReadonlyArray<RuntimeRequestId>,
      canOperateThread: true,
      onRespondToApproval,
    } as unknown as TimelineRowSharedState;
    state.childApprovalsAtom = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);

    await using screen = await render(
      <TimelineRowCtx value={share}>
        <TimelinePendingApprovalRow approval={built.approval} />
      </TimelineRowCtx>,
    );

    await expect.element(screen.getByText("Dependency hold · devtools:r_42")).toBeInTheDocument();
    await expect
      .element(screen.getByText(/effect 4\.0\.0-beta\.40→4\.0\.0-beta\.47/u))
      .toBeInTheDocument();

    await screen.getByRole("button", { name: "Approve", exact: true }).click();
    expect(onRespondToApproval).toHaveBeenCalledWith(built.requestId, "accept");

    await screen.getByRole("button", { name: "Reject (24h)", exact: true }).click();
    expect(onRespondToApproval).toHaveBeenCalledWith(built.requestId, "decline");
  });

  it("renders child thread ship-queue dep hold and handles Approve and expired Rescan", async () => {
    const onDecide = vi.fn(async () => AsyncResult.success({ ok: true, started: true }));
    const onScan = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Scan daemon unavailable"))))
      .mockResolvedValueOnce(AsyncResult.success({ ok: true, started: true }));

    const pendingItem: ChildThreadShipQueueDepApproval = {
      childThreadId: ThreadId.make("child-sq-1"),
      childTitle: "Subagent shipper",
      entry: buildShipQueueDepApproval({ hold: freshHold(), nowMs: FIXED_NOW_MS }),
    };
    const expiredItem: ChildThreadShipQueueDepApproval = {
      childThreadId: ThreadId.make("child-sq-2"),
      childTitle: "Stale shipper",
      entry: buildShipQueueDepApproval({
        hold: freshHold({
          repo: "old-repo",
          reportId: "old-repo:r_1",
          scannedAt: FIXED_NOW_SEC - 90_000,
        }),
        nowMs: FIXED_NOW_MS,
      }),
    };

    state.childApprovalsAtom = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);
    state.canOperate = true;

    await using screen = await render(
      <ChildThreadApprovals
        threadRef={{ environmentId: envId, threadId }}
        shipQueueDepApprovals={[pendingItem, expiredItem]}
        onDecideShipQueueDeps={onDecide}
        onScanShipQueueDeps={onScan}
      />,
    );

    await expect.element(screen.getByText(/Subagent shipper/u)).toBeInTheDocument();
    await expect.element(screen.getByText(/Stale shipper/u)).toBeInTheDocument();

    await screen.getByRole("button", { name: "Approve", exact: true }).click();
    expect(onDecide).toHaveBeenCalledWith({
      environmentId: envId,
      input: { reportId: "devtools:r_42", decision: "approve" },
    });

    await screen.getByRole("button", { name: "Rescan", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Scan daemon unavailable");

    await screen.getByRole("button", { name: "Rescan", exact: true }).click();
    expect(onScan).toHaveBeenCalledWith({
      environmentId: envId,
      input: { repo: "old-repo" },
    });
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("renders live rail job with 7 deploy segments, dep hold notice, Queue navigation, and Cancel", async () => {
    state.navigate.mockReset();
    state.cancelCmd.mockReset();
    state.cancelCmd.mockResolvedValue(AsyncResult.success({ ok: true }));
    state.canOperate = true;

    const liveJob: ShipQueueJob = {
      id: "801",
      repo: "devtools",
      branch: "feat/s6",
      title: "Ship S6 (#88)",
      state: "running",
      stage: "deploy",
      postMerge: true,
      mergeExit: 0,
      pr: "88",
      prRepo: "private-repo",
      lastMarker: "POST_MERGE job=801",
      threadId: threadId,
      submittedAt: new Date(FIXED_NOW_MS - 45_000).toISOString(),
    };
    const hold = freshHold();
    state.snap = {
      available: true,
      daemonRunning: true,
      daemonPid: 777,
      openCount: 1,
      totalCount: 1,
      jobs: [liveJob],
      deps: [hold],
    };
    state.threadJobs = [liveJob];

    await using screen = await render(
      <TooltipProvider>
        <ThreadShipQueuePanel
          environmentId={envId}
          threadId={threadId}
          branch="feat/s6"
          worktreePath="/dataprivate-repo"
          gitCwd="/dataprivate-repo"
        />
      </TooltipProvider>,
    );

    await expect.element(screen.getByText("Deploying")).toBeInTheDocument();
    await expect.element(screen.getByText("#88")).toBeInTheDocument();
    await expect.element(screen.getByText(/Waiting on dependency approval/u)).toBeInTheDocument();

    const segments = page.getByRole("group", { name: "Ship progress steps" }).getByRole("button");
    expect(segments.elements()).toHaveLength(7);

    await screen.getByRole("button", { name: "Queue", exact: true }).click();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/machines",
      search: { env: envId, tab: "ship-queue" },
    });

    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.cancelCmd).toHaveBeenCalledWith({
      environmentId: envId,
      input: { jobId: "801" },
    });
  });

  it("dismisses finished linger job card cleanly", async () => {
    const doneJob: ShipQueueJob = {
      id: "802",
      repo: "devtools",
      branch: "feat/done",
      title: "Landed S5",
      state: "done",
      pr: "85",
      prRepo: "private-repo",
      threadId: threadId,
      submittedAt: new Date(FIXED_NOW_MS - 120_000).toISOString(),
      lastMarker: `CLEANED at=${new Date(FIXED_NOW_MS - 30_000).toISOString()}`,
    };
    state.snap = {
      available: true,
      daemonRunning: true,
      daemonPid: 777,
      openCount: 0,
      totalCount: 1,
      jobs: [doneJob],
      deps: [],
    };
    state.threadJobs = [doneJob];

    await using screen = await render(
      <TooltipProvider>
        <ThreadShipQueuePanel
          environmentId={envId}
          threadId={threadId}
          branch="feat/done"
          worktreePath={null}
          gitCwd="/dataprivate-repo"
        />
      </TooltipProvider>,
    );

    await expect.element(screen.getByText("Shipped")).toBeInTheDocument();
    await screen.getByRole("button", { name: "Dismiss ship job" }).click();
    expect(page.getByText("Shipped").query()).toBeNull();
  });
});
