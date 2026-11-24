import "~/index.css";

import {
  EnvironmentId,
  ThreadId,
  type ShipQueueDepRepo,
  type ShipQueueJob,
  type ShipQueueSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const FIXED_NOW_MS = Date.parse("2026-11-23T18:00:00.000Z");
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

const state = vi.hoisted(() => ({
  nowMs: Date.parse("2026-11-23T18:00:00.000Z"),
  navigate: vi.fn(),
  cancelCmd: vi.fn(),
  decideCmd: vi.fn(),
  scanCmd: vi.fn(),
  canDecide: true,
  canOperate: true,
  snap: {
    available: true,
    daemonRunning: true,
    daemonPid: 4242,
    openCount: 0,
    totalCount: 0,
    jobs: [] as ShipQueueJob[],
    deps: [] as ShipQueueDepRepo[],
  } as ShipQueueSnapshot,
  threads: [] as Array<{
    readonly id: ThreadId;
    readonly deletedAt: string | null;
    readonly archivedAt: string | null;
  }>,
}));

vi.mock("../../hooks/useNowSecond", () => ({
  useNowSecond: () => state.nowMs,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => state.canOperate,
}));

vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      cancelShipQueueJob: { __mockTag: "cancel" },
      decideShipQueueDeps: { __mockTag: "decide" },
      scanShipQueueDeps: { __mockTag: "scan" },
    },
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (desc: { __mockTag?: string }) => {
    if (desc.__mockTag === "cancel") return state.cancelCmd;
    if (desc.__mockTag === "decide") return state.decideCmd;
    return state.scanCmd;
  },
}));

vi.mock("../../state/shipQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/shipQueue")>();
  return {
    ...actual,
    useShipQueueSnapshot: () => state.snap,
    canDecideShipQueueDepsAtom: () => Atom.make(state.canDecide),
  };
});

vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/threads")>();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      environmentThreadsAtom: () => Atom.make(state.threads as never),
    },
  };
});

import { MachineShipQueuePanel } from "./MachineShipQueuePanel";

const envId = EnvironmentId.make("env-sq-machine");
const liveThreadId = ThreadId.make("thread-live-1");

function resetMocks() {
  state.navigate.mockReset();
  state.cancelCmd.mockReset();
  state.decideCmd.mockReset();
  state.scanCmd.mockReset();
  state.cancelCmd.mockResolvedValue(AsyncResult.success({ ok: true }));
  state.decideCmd.mockResolvedValue(AsyncResult.success({ ok: true, started: true }));
  state.scanCmd.mockResolvedValue(AsyncResult.success({ ok: true, started: true }));
  state.canDecide = true;
  state.canOperate = true;
}

describe("MachineShipQueuePanel", () => {
  it("renders summary badges, dep holds actions, expanded step tracker, filters, and job controls", async () => {
    resetMocks();
    const nowSec = FIXED_NOW_SEC;
    state.threads = [{ id: liveThreadId, deletedAt: null, archivedAt: null }];
    state.snap = {
      available: true,
      daemonRunning: true,
      daemonPid: 4242,
      openCount: 1,
      totalCount: 2,
      jobs: [
        {
          id: "901",
          repo: "devtools",
          branch: "feat/s6",
          title: "Ship Queue UI (#101)",
          state: "running",
          routeHost: "buildbox-1",
          pr: "101",
          prRepo: "private-repo",
          threadId: liveThreadId,
          submittedAt: new Date(FIXED_NOW_MS - 35_000).toISOString(),
        },
        {
          id: "900",
          repo: "t3code",
          branch: "fix/s5",
          title: "Fix grant (#95)",
          state: "failed",
          pushExit: 0,
          pr: "95",
          mergeExit: 1,
          reason: "merge conflict in lockfile",
          submittedAt: new Date(FIXED_NOW_MS - 300_000).toISOString(),
        },
      ],
      deps: [
        {
          repo: "devtools",
          reportId: "devtools:r_55",
          status: "pending",
          scannedAt: nowSec - 30,
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
        },
      ],
    };

    await using screen = await render(<MachineShipQueuePanel environmentId={envId} />);

    await expect.element(screen.getByText("Daemon running")).toBeInTheDocument();
    await expect.element(screen.getByText("1 active")).toBeInTheDocument();
    await expect.element(screen.getByText("1 failed")).toBeInTheDocument();
    await expect.element(screen.getByText("1 holds")).toBeInTheDocument();
    await expect
      .element(screen.getByText(/effect: 4\.0\.0-beta\.40 → 4\.0\.0-beta\.47/u))
      .toBeInTheDocument();

    await screen.getByRole("button", { name: "Approve", exact: true }).click();
    expect(state.decideCmd).toHaveBeenCalledWith({
      environmentId: envId,
      input: { reportId: "devtools:r_55", decision: "approve" },
    });

    await screen.getByRole("button", { name: "Reject (24h)", exact: true }).click();
    expect(state.decideCmd).toHaveBeenCalledWith({
      environmentId: envId,
      input: { reportId: "devtools:r_55", decision: "reject" },
    });

    await screen.getByRole("button", { name: "Expand ship steps" }).first().click();
    await expect.element(screen.getByText("Merge Gate")).toBeInTheDocument();

    await screen.getByRole("button", { name: "Open thread", exact: true }).click();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: liveThreadId },
    });

    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.cancelCmd).toHaveBeenCalledWith({
      environmentId: envId,
      input: { jobId: "901" },
    });

    await screen.getByLabelText("Filter ship jobs").fill("nonexistent-branch-xyz");
    await expect.element(screen.getByText("No matching ship jobs")).toBeInTheDocument();
    await screen.getByLabelText("Filter ship jobs").fill("");
    expect(page.getByText("No matching ship jobs").query()).toBeNull();
  });

  it("renders empty state when queue has no jobs", async () => {
    resetMocks();
    state.threads = [];
    state.snap = {
      available: true,
      daemonRunning: false,
      daemonPid: null,
      openCount: 0,
      totalCount: 0,
      jobs: [],
      deps: [],
    };

    await using screen = await render(<MachineShipQueuePanel environmentId={envId} />);
    await expect.element(screen.getByText("Daemon stopped")).toBeInTheDocument();
    await expect.element(screen.getByText("No ship jobs yet")).toBeInTheDocument();
  });
});
