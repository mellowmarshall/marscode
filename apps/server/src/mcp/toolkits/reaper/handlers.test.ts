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

import * as ServerConfig from "../../../config.ts";
import * as ReaperPolicy from "../../../devtools/ReaperPolicy.ts";
import * as ReaperProposals from "../../../devtools/reaper/ReaperProposals.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
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
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const toolkit = yield* ReaperToolkit;
      const proposals = yield* ReaperProposals.ReaperProposals;
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
      // Proposing alone never touches the policy.
      expect(NodeFS.existsSync(policyPath)).toBe(false);

      const afterAccept = yield* proposals.decide({ id: pending[0]!.id, decision: "accept" });
      expect(afterAccept.map((p) => p.path)).toEqual([tmpDir]);
      expect(ReaperPolicy.readReaperPolicySync([], policyPath).rules).toEqual([
        { path: cacheDir, maxAgeDays: 14, keepLatest: 2, enabled: true },
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
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ReaperHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
