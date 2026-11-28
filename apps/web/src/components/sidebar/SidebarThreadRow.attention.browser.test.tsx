import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock("../../devtools/devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../devtools/devtoolsClient")>();
  // No server: every DevTools read answers "not found", so only the thread shell sets status.
  return {
    ...actual,
    fetchDevtoolsJson: () =>
      Promise.resolve({ ok: false, status: 404, data: null, error: "Not found" }),
  };
});

import "~/index.css";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { TooltipProvider } from "../ui/tooltip";
import { SortableThreadRow } from "./SidebarThreadRow";

const ENV = EnvironmentId.make("env-local");

function Row(props: { readonly secret: boolean; readonly question: boolean }) {
  return (
    <TooltipProvider delay={0}>
      <ul className="m-0 list-none bg-sidebar p-2">
        <SortableThreadRow
          sortableId="thread-a"
          sortableDisabled
          contextDrag={false}
          thread={makeThreadFixture({
            id: ThreadId.make("thread-a"),
            environmentId: ENV,
            projectId: ProjectId.make("project-a"),
            title: "Install build tools",
            branch: null,
            hasPendingUserInput: props.secret || props.question,
            hasPendingSecretRequest: props.secret,
          })}
          variant="card"
          variantAction="settle"
          settlementSupported
          snoozeSupported={false}
          pinningSupported={false}
          isPinned={false}
          dropVerb={null}
          dragOverPinned={false}
          sweepAction={null}
          snoozeWakeLabelText={null}
          wokeAt={null}
          isActive={false}
          isRouteThread={false}
          readOpensPullRequestsInRightPanel={() => false}
          jumpLabel={null}
          environmentLabel={null}
          environmentMachine="linux"
          project={null}
          projectDisplayName="example-repo"
          providerEntryByInstanceId={new Map()}
          timestampFormat="locale"
          onThreadClick={() => {}}
          onThreadActivate={() => {}}
          onStartRename={() => {}}
          onRenameTitleChange={() => {}}
          onCommitRename={() => {}}
          onCancelRename={() => {}}
          isRenaming={false}
          renamingTitle=""
          onContextMenu={() => {}}
          onSettle={() => {}}
          onActionSweepStart={() => {}}
          onUnsettle={() => {}}
          onSnooze={() => {}}
          onUnsnooze={() => {}}
          onUnpin={() => {}}
          onAcknowledgeWoke={() => {}}
        />
      </ul>
    </TooltipProvider>
  );
}

describe("sidebar row attention for a pending secret request", () => {
  it("glows and reads Approval in red, like any approval", async () => {
    await using _screen = await render(<Row secret question={false} />);
    const label = page.getByText("Approval", { exact: true });
    await expect.element(label).toBeVisible();
    expect(label.element().closest(".text-destructive")).not.toBeNull();
    const row = document.querySelector(".sidebar-approval-glow");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Install build tools");
    expect(getComputedStyle(row!).animationName).toBe("approval-row-glow");
  });

  it("keeps an ordinary question as Input, without the glow", async () => {
    await using _screen = await render(<Row secret={false} question />);
    await expect.element(page.getByText("Input", { exact: true })).toBeVisible();
    expect(document.querySelector(".sidebar-approval-glow")).toBeNull();
  });
});
