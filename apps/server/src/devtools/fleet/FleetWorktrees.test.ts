// Real-Git tests for the native fleet worktrees panel: temp repositories, a real origin, and linked worktrees.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { makeFleetWorktreesCollector } from "./FleetWorktrees.ts";

const NOW = "2026-11-27T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const RECENT = "2026-11-27T11:00:00Z";
const MONTH_AGO = "2026-10-27T12:00:00Z";

const mergedHeads = new Map<string, string>();

const platformLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const testLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
      detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(GitManager.GitManager)({
      // Stands in for the GitHub host: the branch's pull request merged at a recorded head.
      branchPullRequest: ({ branch }) => {
        const headSha = mergedHeads.get(branch);
        return Effect.succeed(
          headSha === undefined
            ? null
            : ({
                state: "merged",
                headRef: branch,
                baseRef: "main",
                headSha,
              } as GitManager.GitBranchPullRequest),
        );
      },
    }),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-worktrees-" }).pipe(
      Layer.provide(platformLayer),
    ),
  ),
  Layer.provideMerge(platformLayer),
);

it.layer(platformLayer)("FleetWorktrees", (it) => {
  it.effect(
    "reports dirty, merged, stale, and stuck linked worktrees of each project repository",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fleet-wt-" });
        const upstream = `${tmp}/upstream`;
        const primary = `${tmp}/primary`;
        yield* fileSystem.makeDirectory(upstream);

        const git = (cwd: string, args: ReadonlyArray<string>, date = RECENT) =>
          driver.execute({
            operation: "test.fleetWorktrees",
            cwd,
            args: ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
            env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
          });
        const head = (cwd: string) =>
          git(cwd, ["rev-parse", "HEAD"]).pipe(Effect.map((r) => r.stdout.trim()));

        yield* git(upstream, ["init", "-b", "main"]);
        yield* git(upstream, ["commit", "--allow-empty", "-m", "init"]);
        yield* git(tmp, ["clone", upstream, primary]);

        // Merged: its pull request merged at this exact head (squash merge, so not integrated).
        yield* git(primary, ["worktree", "add", "-b", "feat/merged", `${tmp}/wt-merged`]);
        yield* git(`${tmp}/wt-merged`, ["commit", "--allow-empty", "-m", "merged work"]);
        mergedHeads.set("feat/merged", yield* head(`${tmp}/wt-merged`));

        // Dirty: an uncommitted file in a fresh worktree.
        yield* git(primary, ["worktree", "add", "-b", "feat/dirty", `${tmp}/wt-dirty`]);
        yield* fileSystem.writeFileString(`${tmp}/wt-dirty/notes.txt`, "wip\n");

        // Stale and stuck: a month-old commit that never reached origin.
        yield* git(primary, ["worktree", "add", "-b", "feat/old", `${tmp}/wt-old`]);
        yield* git(`${tmp}/wt-old`, ["commit", "--allow-empty", "-m", "old work"], MONTH_AGO);

        const collector = yield* makeFleetWorktreesCollector;
        // The primary and one of its worktrees are both projects; the repository counts once.
        const panel = yield* collector.collect({
          projectRoots: [primary, `${tmp}/wt-dirty`, `${tmp}/not-a-repo`],
          nowMs: NOW_MS,
        });

        assert.strictEqual(panel.repos.length, 1);
        const repo = panel.repos[0]!;
        assert.strictEqual(repo.repo, "primary");
        const byBranch = new Map(repo.items.map((item) => [item.branch, item]));
        assert.deepEqual([...byBranch.keys()].toSorted(), [
          "feat/dirty",
          "feat/merged",
          "feat/old",
        ]);

        const merged = byBranch.get("feat/merged")!;
        assert.strictEqual(merged.merged, true);
        assert.strictEqual(merged.ahead, 1);
        assert.strictEqual(merged.stale, false);
        assert.strictEqual(merged.stuck, undefined);

        const dirty = byBranch.get("feat/dirty")!;
        assert.strictEqual(dirty.dirty, true);
        assert.strictEqual(dirty.merged, undefined);
        assert.strictEqual(dirty.stale, false);
        assert.strictEqual(dirty.stuck, undefined);
        assert.strictEqual(dirty.last_commit_at.slice(0, 10), "2026-11-27");

        const old = byBranch.get("feat/old")!;
        assert.strictEqual(old.stale, true);
        assert.strictEqual(old.stuck, true);
        assert.strictEqual(old.unpushed, 1);
        assert.strictEqual(old.dirty, undefined);

        assert.deepEqual(
          { total: panel.total, dirty: panel.dirty, merged: panel.merged, stale: panel.stale },
          { total: 3, dirty: 1, merged: 1, stale: 1 },
        );
        assert.strictEqual(panel.stuck, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("returns an empty panel when no project has linked worktrees", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fleet-wt-solo-" });
      yield* driver.execute({ operation: "test.init", cwd, args: ["init", "-b", "main"] });
      const collector = yield* makeFleetWorktreesCollector;
      const panel = yield* collector.collect({ projectRoots: [cwd], nowMs: NOW_MS });
      assert.deepEqual(panel, { total: 0, dirty: 0, stale: 0, merged: 0, stuck: 0, repos: [] });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
