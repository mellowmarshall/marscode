import { EnvironmentId, ThreadId, type ReaperRuleProposal } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const fetchSpy = vi.fn();

vi.mock("./devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./devtoolsClient")>();
  return { ...actual, fetchDevtoolsJson: (...args: unknown[]) => fetchSpy(...args) };
});

import "~/index.css";
import { render } from "../../test/render";
import { FleetReaperTab } from "./FleetReaperTab";

const CACHE_RULE: ReaperRuleProposal = {
  id: "reaper-proposal:1",
  host: "host-a",
  threadId: ThreadId.make("thread:review"),
  proposedAt: "2026-11-20T10:00:00.000Z",
  path: "/home/user/.cache/acme-build",
  maxAgeDays: 14,
  keepLatest: 2,
  deletes: "Build cache entries the acme tool has not used in two weeks.",
  safeBecause: "Only the acme tool writes here, and it rebuilds the cache on the next build.",
  estimatedBytes: 3_221_225_472,
};
const SCRATCH_RULE: ReaperRuleProposal = {
  id: "reaper-proposal:2",
  host: "host-a",
  proposedAt: "2026-11-20T10:00:00.000Z",
  path: "/tmp/acme-scratch",
  maxAgeDays: 3,
  keepLatest: 0,
  deletes: "Scratch output from test runs older than three days.",
  safeBecause: "Test runs recreate it, and nothing reads old runs.",
};

function mockReaperHost() {
  let pending = [CACHE_RULE, SCRATCH_RULE];
  const rules = [{ path: "/srv/results", maxAgeDays: 30, keepLatest: 3, enabled: false }];
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(
    (_env: string, subPath: string, options?: { method?: string; body?: unknown }) => {
      const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, data });
      if (subPath === "/reaper/proposals") return ok({ proposals: pending });
      if (subPath === "/storage/scan") {
        return ok({
          manifest: null,
          storageCleanupReport: null,
          hostScan: {
            host: "host-a",
            scanned_at: "2026-11-20T10:00:00Z",
            high_pressure: false,
            mounts: [{ mount: "/", used_pct: 81.2, avail_bytes: 96_636_764_160 }],
          },
        });
      }
      if (subPath === "/reaper/status") {
        return ok({
          protected: { sessions: 12, worktrees: 4, paths: 180 },
          orphan_candidates: [],
          stale_tmp: { max_age_hours: 24, roots: ["/tmp"], dirs: 2, files: 5, skipped_active: 0 },
          cargo_last_run: { stamp_path: "/tmp/stamp", last_run: null, age_s: null },
        });
      }
      if (subPath === "/reaper/proposals/decide") {
        const { id, decision } = (options?.body ?? {}) as { id: string; decision: string };
        const chosen = pending.find((p) => p.id === id)!;
        if (decision === "accept") {
          rules.push({
            path: chosen.path,
            maxAgeDays: chosen.maxAgeDays,
            keepLatest: 2,
            enabled: true,
          });
        }
        pending = pending.filter((p) => p.id !== id);
        return ok({ proposals: pending });
      }
      if (subPath === "/reaper/policy") {
        return ok({
          policyPath: "/home/user/.config/reaper/policy.toml",
          rules: [...rules],
          protectedHistoryRoots: ["/home/user/.t3/userdata/statev2.sqlite"],
        });
      }
      return Promise.resolve({ ok: false, status: 404, data: null, error: "Not found" });
    },
  );
}

it("shows proposed rules in plain words and moves an accepted one into the approved rules", async () => {
  mockReaperHost();
  await using _screen = await render(
    <FleetReaperTab
      environmentId={EnvironmentId.make("local-host")}
      localHostName="host-a"
      mergedWorktreesCount={0}
      onFeedback={vi.fn()}
    />,
  );

  const panel = page.getByRole("region", { name: "Proposed cleanup rules" });
  await expect.element(panel.getByText("Proposed cleanup rules (2)")).toBeVisible();
  await expect.element(panel.getByText(CACHE_RULE.deletes)).toBeVisible();
  await expect.element(panel.getByText(CACHE_RULE.safeBecause)).toBeVisible();
  await expect.element(panel.getByText(/about 3(\.0)? GiB/)).toBeVisible();

  await page.getByRole("button", { name: `Accept rule for ${CACHE_RULE.path}` }).click();
  expect(fetchSpy).toHaveBeenCalledWith(
    "local-host",
    "/reaper/proposals/decide",
    expect.objectContaining({ method: "POST", body: { id: CACHE_RULE.id, decision: "accept" } }),
  );
  await expect.element(panel.getByText("Proposed cleanup rules (1)")).toBeVisible();
  const paths = page.getByLabelText("Cleanup directory path");
  await expect.element(paths.nth(1)).toHaveValue(CACHE_RULE.path);

  await page.getByRole("button", { name: `Reject rule for ${SCRATCH_RULE.path}` }).click();
  await expect.element(panel).not.toBeInTheDocument();
  await expect.element(paths.nth(2)).not.toBeInTheDocument();
});

it("keeps proposals read-only while a remote machine is selected", async () => {
  mockReaperHost();
  await using _screen = await render(
    <FleetReaperTab
      environmentId={EnvironmentId.make("local-host")}
      localHostName="host-a"
      selectedHostName="remote-box"
      isSelectedHostLocal={false}
      mergedWorktreesCount={0}
      onFeedback={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: `Accept rule for ${CACHE_RULE.path}` }))
    .toBeDisabled();
});
