// @effect-diagnostics nodeBuiltinImport:off - Real temp policy file and home for the propose, accept, policy path.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ReaperPolicy from "../../../devtools/ReaperPolicy.ts";
import * as ReaperProposals from "../../../devtools/reaper/ReaperProposals.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ReaperHandlers from "./handlers.ts";
import { ReaperToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:reaper-review");

it.effect("queues the agent's proposed rules and writes accepted ones into the policy", () =>
  Effect.gen(function* () {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "reaper-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const homeDir = NodePath.join(root, "home");
    const policyPath = NodePath.join(root, "policy.toml");
    const cacheDir = NodePath.join(homeDir, ".cache", "acme-build");
    const tmpDir = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(cacheDir, { recursive: true });
    NodeFS.mkdirSync(tmpDir, { recursive: true });
    const checkout = NodePath.join(root, "acme-app");
    NodeFS.mkdirSync(NodePath.join(checkout, ".git"), { recursive: true });

    const layerDependencies = Layer.mergeAll(
      ReaperProposals.layerAt({ policyPath, homeDir }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:reaper"),
        requestNamespace: "provider:reaper",
        thread: {
          threadId,
          providerSessionId: "provider:reaper",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
    ).pipe(
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "reaper-proposals-" })),
      Layer.provideMerge(ProcessRunner.layer),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* ReaperToolkit;
      const proposals = yield* ReaperProposals.ReaperProposals;
      const config = yield* ServerConfig.ServerConfig;
      // A fixed epoch: the dry-run compares file times with the Clock.
      const nowMs = 1_767_225_600_000;
      yield* TestClock.setTime(nowMs);
      const daysAgo = (days: number) => (nowMs - days * 86_400_000) / 1000;
      for (const [name, days] of [
        ["a", 1],
        ["b", 20],
        ["c", 30],
        ["d", 40],
      ] as const) {
        const file = NodePath.join(cacheDir, name);
        NodeFS.writeFileSync(file, "x".repeat(5000));
        NodeFS.utimesSync(file, daysAgo(days), daysAgo(days));
      }

      const result = yield* toolkit
        .handle("t3_reaper_propose_rules", {
          rules: [
            {
              path: cacheDir,
              maxAgeDays: 14,
              keepLatest: 2,
              deletes: "Build cache entries the acme tool has not touched in two weeks.",
              safeBecause: "The acme tool rebuilds its cache on the next build.",
            },
            {
              path: checkout,
              maxAgeDays: 7,
              keepLatest: 0,
              deletes: "The whole acme-app checkout.",
              safeBecause: "It looked unused.",
            },
            {
              path: tmpDir,
              maxAgeDays: 3,
              keepLatest: 1,
              deletes: "Old scratch output.",
              safeBecause: "Scratch output is temporary.",
            },
          ],
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      expect(result).toMatchObject({
        queued: [{ path: cacheDir }, { path: tmpDir }],
        refused: [{ path: checkout, reason: expect.stringContaining("git checkout") }],
      });
      const pending = yield* proposals.list;
      expect(pending.map((p) => [p.path, p.threadId])).toEqual([
        [cacheDir, threadId],
        [tmpDir, threadId],
      ]);
      // The dry-run measures what the sweep would remove now: past keepLatest and maxAgeDays.
      expect(pending[0]?.preview).toMatchObject({
        entries: 2,
        oldestAgeDays: 40,
        newestAgeDays: 30,
        gitAncestor: false,
      });
      expect(pending[0]?.preview?.bytes).toBeGreaterThan(0);
      expect(pending[1]?.preview).toMatchObject({ entries: 0, oldestAgeDays: null });
      // Proposing alone never touches the policy, and a dry-run deletes nothing.
      expect(NodeFS.existsSync(policyPath)).toBe(false);
      expect(NodeFS.readdirSync(cacheDir)).toHaveLength(4);

      // A second proposal for a pending path is refused, not swapped in.
      const repeat = yield* proposals.propose({
        rules: [{ path: tmpDir, maxAgeDays: 9, keepLatest: 0, deletes: "x", safeBecause: "y" }],
      });
      expect(repeat.refused[0]?.reason).toContain("already waits");

      // Accepting writes the rule turned off; the user turns it on.
      const afterAccept = yield* proposals.decide({ id: pending[0]!.id, decision: "accept" });
      expect(afterAccept.map((p) => p.path)).toEqual([tmpDir]);
      expect(ReaperPolicy.readReaperPolicySync([], policyPath).rules).toEqual([
        { path: cacheDir, maxAgeDays: 14, keepLatest: 2, enabled: false },
      ]);

      expect(yield* proposals.decide({ id: pending[1]!.id, decision: "reject" })).toEqual([]);
      expect(ReaperPolicy.readReaperPolicySync([], policyPath).rules).toHaveLength(1);

      const again = yield* proposals
        .decide({ id: pending[1]!.id, decision: "accept" })
        .pipe(Effect.flip);
      expect(again._tag).toBe("ReaperProposalNotFoundError");

      // A rule the policy already holds is refused instead of queued twice.
      const duplicate = yield* proposals.propose({
        rules: [{ path: cacheDir, maxAgeDays: 7, keepLatest: 1, deletes: "x", safeBecause: "y" }],
      });
      expect(duplicate.queued).toEqual([]);
      expect(duplicate.refused[0]?.reason).toContain("already exists");

      // Accept fails closed on a policy it cannot read or parse: no rewrite, proposal kept.
      const [retry] = (yield* proposals.propose({
        rules: [{ path: tmpDir, maxAgeDays: 3, keepLatest: 1, deletes: "x", safeBecause: "y" }],
      })).queued;
      const corrupt = `[[approved]]\npath = ${cacheDir}\nmax_age_days = soon\n`;
      NodeFS.writeFileSync(policyPath, corrupt);
      const refusedCorrupt = yield* proposals
        .decide({ id: retry!.id, decision: "accept" })
        .pipe(Effect.flip);
      expect(refusedCorrupt._tag).toBe("ReaperProposalRefusedError");
      expect(refusedCorrupt.message).toContain("Could not parse the reaper policy");
      expect(NodeFS.readFileSync(policyPath, "utf8")).toBe(corrupt);
      // A malformed header must not end a rule early: its later keys would be lost on rewrite.
      const brokenHeader = [
        "[[approved]]",
        `path = "${cacheDir}"`,
        "enabled = true",
        "[broken",
        "max_age_days = 365",
        "",
      ].join("\n");
      NodeFS.writeFileSync(policyPath, brokenHeader);
      expect(ReaperPolicy.readReaperPolicySync([], policyPath).rules).toEqual([]);
      const refusedHeader = yield* proposals
        .decide({ id: retry!.id, decision: "accept" })
        .pipe(Effect.flip);
      expect(refusedHeader.message).toContain("malformed section header [broken");
      const refusedSave = yield* proposals
        .savePolicy([{ path: cacheDir, maxAgeDays: 365, keepLatest: 2, enabled: true }])
        .pipe(Effect.flip);
      expect(refusedSave.message).toContain("Could not parse the reaper policy");
      expect(NodeFS.readFileSync(policyPath, "utf8")).toBe(brokenHeader);
      NodeFS.rmSync(policyPath);
      NodeFS.mkdirSync(policyPath);
      const refusedUnreadable = yield* proposals
        .decide({ id: retry!.id, decision: "accept" })
        .pipe(Effect.flip);
      expect(refusedUnreadable.message).toContain("Could not read the reaper policy");
      expect(NodeFS.readdirSync(policyPath)).toEqual([]);
      expect((yield* proposals.list).map((p) => p.id)).toEqual([retry!.id]);

      // A corrupt store is kept as a copy and reads as empty.
      const storePath = NodePath.join(config.stateDir, "reaper", "proposals.json");
      NodeFS.writeFileSync(storePath, "{not json");
      expect(yield* proposals.list).toEqual([]);
      expect(NodeFS.readFileSync(`${storePath}.corrupt`, "utf8")).toBe("{not json");
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ReaperHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
