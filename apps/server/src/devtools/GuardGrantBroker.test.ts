// @effect-diagnostics nodeBuiltinImport:off - Real Unix-socket + SQLite + Ed25519 integration tests for GuardGrantBroker.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { canonicalProtectedDiffSha256, computeBundleKey } from "@t3tools/guard-protocol/digests";
import type { ActiveSecretGrant } from "@t3tools/guard-protocol/protocol";
import { verifyBundleGrant } from "@t3tools/guard-protocol/signing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GuardGrants from "../persistence/GuardGrants.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { GuardGrantBroker } from "./GuardGrantBroker.ts";

function sendRpc(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = NodeNet.createConnection({ path: socketPath });
    let buf = "";
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    });
    conn.once("connect", () => {
      conn.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

describe("GuardGrantBroker bundled content-digest approvals & SQLite persistence", () => {
  it.effect(
    "reuses Ed25519-signed bundled approval across CI resubmits and later protected edits on the branch, invalidates on PR merge, and forces whole-commit gates to once-only",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* GuardGrants.GuardGrantsRepository;
        const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "guard-bundle-test-"));
        const sockPath = NodePath.join(tmpDir, "guard.sock");

        const testSecretGrantId = `secret-grant:${"a".repeat(32)}`;
        const secretList: ActiveSecretGrant[] = [
          {
            kind: "secret_access",
            grantId: testSecretGrantId,
            threadId: "thread-alpha",
            projectId: "proj-1",
            delivery: "file",
            summary: "Sudo password",
            createdAt: "2026-11-27T00:00:00.000Z",
            expiresAt: "2026-11-28T00:00:00.000Z",
          },
        ];

        let activeThreadId = "thread-alpha";
        let bundleLookups = 0;
        const bundleLookupWaiters: Array<() => void> = [];
        const waitForBundleLookups = (target: number) =>
          bundleLookups >= target
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                bundleLookupWaiters.push(() => {
                  if (bundleLookups >= target) resolve();
                });
              });

        const basePersistence = yield* GuardGrants.makeGuardBundlePersistenceEffect(repo);

        const broker = new GuardGrantBroker({
          socketPath: sockPath,
          signingStateDir: tmpDir,
          resolvePeerThreadId: async () => ({
            verified: true,
            threadId: activeThreadId,
            peerPid: 4242,
          }),
          bundlePersistence: {
            ...basePersistence,
            findActiveByBundleKey: async (key, tid) => {
              const found = await basePersistence.findActiveByBundleKey(key, tid);
              bundleLookups += 1;
              for (const notify of bundleLookupWaiters) notify();
              return found;
            },
          },
          secretGrants: {
            listActiveGrants: async () => [...secretList],
            revokeGrant: async (grantId) => {
              const idx = secretList.findIndex((g) => g.grantId === grantId);
              if (idx === -1) return false;
              secretList.splice(idx, 1);
              return true;
            },
          },
        });

        try {
          yield* Effect.promise(() => broker.start("linux"));

          const diffSha1 = canonicalProtectedDiffSha256(
            "diff --git a/host-guards/exceptions.json\n+marscode",
          );
          const bundle1 = {
            repo: "example-org/example-repo",
            branch: "issue-1352",
            pr_or_issue: "#1352",
            gates: [{ gate_id: "allowlist", reason: "exceptions.json modified" }],
            protected_paths: ["host-guards/exceptions.json"],
            protected_diff_sha256: diffSha1,
            body_sha256: "",
            commit_sha: "a".repeat(40),
            diff_preview: '+  "marscode": { "playbook": { "*": "waived" } }',
          };

          // 1. Two concurrent identical requests coalesce into ONE pending modal.
          let pendingAddedResolve: (() => void) | null = null;
          const pendingAdded = new Promise<void>((resolve) => {
            pendingAddedResolve = resolve;
          });
          const unsubPending = broker.subscribe((ev) => {
            if (ev.type === "pending_added") pendingAddedResolve?.();
          });
          const req1Promise = sendRpc(sockPath, {
            v: 1,
            op: "request",
            guard: "ship-queue",
            command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352"],
            cwd: tmpDir,
            proposed_reason: "Add marscode waiver",
            bundle: bundle1,
          });
          yield* Effect.promise(() => pendingAdded);
          unsubPending();

          const req2Promise = sendRpc(sockPath, {
            v: 1,
            op: "request",
            guard: "ship-queue",
            command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352"],
            cwd: tmpDir,
            proposed_reason: "Add marscode waiver",
            bundle: bundle1,
          });
          yield* Effect.promise(() => waitForBundleLookups(2));
          // Drain microtasks so req2 attaches to existing.sockets right after findActiveByBundleKey resolves.
          yield* Effect.promise(async () => {
            await Promise.resolve();
            await Promise.resolve();
          });

          const pending = broker.listPending();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.bundleEligible).toBe(true);
          expect(pending[0]?.wholeCommitGates).toEqual([]);

          const resolved = broker.resolveRequest(pending[0]!.requestId, {
            decision: "approve",
            scope: "bundle",
            approvedVia: "test:owner",
          });
          expect(resolved.found).toBe(true);
          expect(resolved.scope).toBe("bundle");
          expect(yield* Effect.promise(() => resolved.persisted!)).toBe(true);

          const [resp1, resp2] = yield* Effect.promise(() =>
            Promise.all([req1Promise, req2Promise]),
          );
          expect(resp1.ok).toBe(true);
          expect(resp1.scope).toBe("bundle");
          expect(resp2.ok).toBe(true);
          expect(resp2.grant_id).toBe(resp1.grant_id);

          // Verify offline Ed25519 signature (includes threadId and expiresAt).
          const stored = yield* repo.findActiveByBundleKey(
            computeBundleKey({
              repo: "example-org/example-repo",
              branch: "issue-1352",
              prOrIssue: "#1352",
              guard: "ship-queue",
              gateIds: ["allowlist"],
              protectedPaths: ["host-guards/exceptions.json"],
              protectedDiffSha256: diffSha1,
              bodySha256: "",
            }),
            "thread-alpha",
          );
          expect(Option.isSome(stored)).toBe(true);
          if (Option.isSome(stored)) {
            expect(stored.value.expiresAt).toBeTruthy();
            expect(
              verifyBundleGrant(
                {
                  v: 1,
                  grantId: stored.value.grantId,
                  bundleKey: stored.value.bundleKey,
                  threadId: stored.value.threadId,
                  repo: stored.value.repo,
                  branch: stored.value.branch,
                  prOrIssue: stored.value.prOrIssue,
                  guard: stored.value.guard,
                  gateIds: stored.value.gateIds,
                  protectedPaths: stored.value.protectedPaths,
                  protectedDiffSha256: stored.value.protectedDiffSha256,
                  bodySha256: stored.value.bodySha256,
                  approvedAt: stored.value.createdAt,
                  expiresAt: stored.value.expiresAt,
                  approvedVia: stored.value.approvedVia,
                },
                stored.value.signature,
                broker.publicKeyPem,
              ),
            ).toBe(true);
          }

          // 2b. Cross-thread reuse is DENIED (thread-beta cannot use thread-alpha's bundle grant).
          activeThreadId = "thread-beta";
          const crossThreadCheck = yield* Effect.promise(() =>
            sendRpc(sockPath, {
              v: 1,
              op: "check",
              guard: "ship-queue",
              command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352"],
              cwd: tmpDir,
              bundle: bundle1,
            }),
          );
          expect(crossThreadCheck.ok).toBe(false);
          activeThreadId = "thread-alpha";

          // 2c. Forged / tampered SQLite row is rejected by signature verification.
          const forgedKey = computeBundleKey({
            repo: "example-org/example-repo",
            branch: "forged-branch",
            prOrIssue: "#9999",
            guard: "ship-queue",
            gateIds: ["allowlist"],
            protectedPaths: ["host-guards/exceptions.json"],
            protectedDiffSha256: diffSha1,
            bodySha256: "",
          });
          yield* repo.createBundleGrant({
            grantId: "t3g_forged_row",
            bundleKey: forgedKey,
            threadId: "thread-alpha",
            repo: "example-org/example-repo",
            branch: "forged-branch",
            worktree: tmpDir,
            prOrIssue: "#9999",
            guard: "ship-queue",
            gateIds: ["allowlist"],
            protectedPaths: ["host-guards/exceptions.json"],
            protectedDiffSha256: diffSha1,
            bodySha256: "",
            summary: "forged",
            reason: "forged",
            approvedVia: "forged",
            signature: Buffer.alloc(64, 7).toString("base64"),
            createdAt: "2026-11-27T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          const forgedCheck = yield* Effect.promise(() =>
            sendRpc(sockPath, {
              v: 1,
              op: "check",
              guard: "ship-queue",
              command: ["submit", "/data/Dev/example-repo/forged", "forged-branch"],
              cwd: tmpDir,
              bundle: { ...bundle1, branch: "forged-branch", pr_or_issue: "#9999" },
            }),
          );
          expect(forgedCheck.ok).toBe(false);

          // 2d. ALWAYS_ONCE_GUARDS (git-push, deps-decide, home-dev-install, fly-deploy) force once-only.
          for (const onceGuard of ["git-push", "deps-decide", "home-dev-install", "fly-deploy"]) {
            const onceQueued = yield* Effect.promise(() =>
              sendRpc(sockPath, {
                v: 1,
                op: "request",
                wait: false,
                guard: onceGuard,
                command: [onceGuard, "arg1"],
                cwd: tmpDir,
                bundle: bundle1,
              }),
            );
            expect(onceQueued.ok).toBe(true);
            const p = broker.listPending()[0];
            expect(p?.bundleEligible).toBe(false);
            const res = broker.resolveRequest(p!.requestId, {
              decision: "approve",
              scope: "bundle",
            });
            expect(res.scope).toBe("once");
          }

          // 2. Resubmit after fixing a normal test file (same protected_diff_sha256, different commit_sha):
          //    reuses the grant immediately with ZERO new modal!
          const resubmitResp = yield* Effect.promise(() =>
            sendRpc(sockPath, {
              v: 1,
              op: "request",
              guard: "ship-queue",
              command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352"],
              cwd: tmpDir,
              bundle: { ...bundle1, commit_sha: "b".repeat(40) },
            }),
          );
          expect(resubmitResp.ok).toBe(true);
          expect(resubmitResp.scope).toBe("bundle");
          expect(resubmitResp.grant_id).toBe(resp1.grant_id);
          expect(broker.listPending()).toHaveLength(0);

          // 3. The approval covers the pull request: a later protected edit on the same branch
          //    needs no new approval, and another branch has none.
          const diffSha2 = canonicalProtectedDiffSha256(
            "diff --git a/host-guards/exceptions.json\n+marscode\n+later",
          );
          const check = (bundle: Record<string, unknown>) =>
            Effect.promise(() =>
              sendRpc(sockPath, {
                v: 1,
                op: "check",
                guard: "ship-queue",
                command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352"],
                cwd: tmpDir,
                bundle,
              }),
            );
          const laterEdit = yield* check({ ...bundle1, protected_diff_sha256: diffSha2 });
          expect(laterEdit.ok).toBe(true);
          expect(laterEdit.grant_id).toBe(resp1.grant_id);
          expect((yield* check({ ...bundle1, branch: "issue-9999" })).ok).toBe(false);

          // 4. Whole-commit gate (`no-review`) is ALWAYS forced to once-only (bundleEligible = false).
          const wholeCommitQueued = yield* Effect.promise(() =>
            sendRpc(sockPath, {
              v: 1,
              op: "request",
              wait: false,
              guard: "ship-queue",
              command: ["submit", "/data/Dev/example-repo/issue-1352", "issue-1352", "--no-review"],
              cwd: tmpDir,
              bundle: {
                ...bundle1,
                gates: [
                  { gate_id: "allowlist", reason: "exceptions.json" },
                  { gate_id: "no-review", reason: "no adversarial review" },
                ],
              },
            }),
          );
          expect(wholeCommitQueued.ok).toBe(true);
          const wcPending = broker.listPending()[0];
          expect(wcPending?.bundleEligible).toBe(false);
          expect(wcPending?.wholeCommitGates).toEqual(["no-review"]);
          const wcResolved = broker.resolveRequest(wcPending!.requestId, {
            decision: "approve",
            scope: "bundle",
          });
          expect(wcResolved.scope).toBe("once");

          // 5. Unified active grants lists BOTH the bundle grant AND the 24h secret grant (never forged row, never private fields), and revokes both!
          const allGrants = yield* Effect.promise(() => broker.listActiveGrants());
          expect(allGrants.map((g) => g.kind).toSorted()).toEqual([
            "guard_bundle",
            "secret_access",
          ]);
          const bundlePublic = allGrants.find((g) => g.kind === "guard_bundle") as
            | Record<string, unknown>
            | undefined;
          expect(bundlePublic).toBeDefined();
          expect("worktree" in bundlePublic!).toBe(false);
          expect("bundleKey" in bundlePublic!).toBe(false);
          expect("signature" in bundlePublic!).toBe(false);

          const secretRevoked = yield* Effect.promise(() => broker.revokeGrant(testSecretGrantId));
          expect(secretRevoked).toBe(true);

          // 6. PR merge auto-invalidates the remaining bundle grant.
          const invalidated = yield* Effect.promise(() =>
            broker.invalidateRepoPr("example-org/example-repo", 1352, "pr-merged"),
          );
          expect(invalidated).toBe(1);
          const afterMerge = yield* Effect.promise(() => broker.listActiveGrants());
          expect(afterMerge).toHaveLength(0);

          // 7. Audit log recorded real broker events in SQLite.
          const events = yield* repo.listRecentEvents(50);
          expect(events.some((e) => e.eventType === "approved")).toBe(true);
          expect(events.some((e) => e.eventType === "used")).toBe(true);
          expect(events.some((e) => e.eventType === "revoked")).toBe(true);

          // 8. Corrupted / bad-permission signing key fails closed (once-only) instead of crashing startup.
          const badKeyDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bad-key-"));
          try {
            NodeFS.writeFileSync(NodePath.join(badKeyDir, "guard-grant-ed25519.pub"), "PUBLIC KEY");
            const fallbackBroker = new GuardGrantBroker({
              socketPath: NodePath.join(badKeyDir, "t3.sock"),
              signingStateDir: badKeyDir,
            });
            expect(fallbackBroker.publicKeyPem).toBe("");
            yield* Effect.promise(() => fallbackBroker.close());
          } finally {
            NodeFS.rmSync(badKeyDir, { recursive: true, force: true });
          }
        } finally {
          yield* Effect.promise(() => broker.close());
          NodeFS.rmSync(tmpDir, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(GuardGrants.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});
