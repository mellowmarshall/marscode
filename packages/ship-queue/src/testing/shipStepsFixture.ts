// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A sample repo with a bare remote, a fake forge, and a queue root for declared-step tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readLog, registerWatcher } from "../jobStore.ts";
import { nodeProcessRunner } from "../nodeProcess.ts";
import { currentProcessIdentity, isProcessAlive } from "../processIdentity.ts";
import { submitJob } from "../submit.ts";
import type { ShipForge, ShipQueueDeps } from "../types.ts";

export const SELF = currentProcessIdentity();
/** Each fixture's teardown; a test file drains it after each test. */
export const fixtureCleanups: Array<() => void> = [];
const cleanups = fixtureCleanups;

export function sh(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

const DECLARATION = [
  "base_ref=origin/main",
  "ship_repo=sample-repo",
  "ship_gh_repo=acme-fixture/sample-repo",
  "ship_body_check=scripts/ship/steps.sh body",
  "ship_install=scripts/ship/steps.sh install",
  "ship_ci=scripts/ship/steps.sh ci",
  "",
].join("\n");

/**
 * The base's step script: CI fails when the branch carries `ci-fail`; each CI run is counted. Each
 * step says which variable names it sees (`env-names:`), and the merge gate fails with the exit
 * the branch's `gate-fail` holds.
 */
const STEPS_SCRIPT = `#!/usr/bin/env bash
names() { echo "env-names: $(compgen -e | sort | tr '\\n' ' ')"; }
case "$1" in
  body)
    names > "$SHIP_QUEUE_STATE/body-env"
    grep -q "Closes #" "$2" || { echo "the PR body names no issue"; exit 1; } ;;
  install) echo "install ok"; names ;;
  ci)
    echo "ci run" >> "\${SHIP_QUEUE_STATE:-/dev/null}/ci-runs"
    if [ -f ci-long ]; then
      for i in $(seq 1 200); do echo "tsc suggestion $i"; done
      printf ' FAIL  src/sum.test.ts > adds two numbers\\nAssertionError: expected 2 to be 3\\n  at src/sum.test.ts:4:17\\n'
      for i in $(seq 1 200); do echo "tsc suggestion after $i"; done
      printf 'check:changed summary\\n  pass  lint\\n  FAIL  test (4 files)\\n'
      for i in $(seq 1 60); do echo "hygiene: tail line $i"; done
      exit 1
    fi
    if [ -f ci-fail ]; then for i in $(seq 1 60); do echo "noise line $i"; done; echo "ci: 1 test failed in ci-fail"; exit 3; fi
    echo "ci: 42 tests passed at $(git rev-parse --short HEAD) base \${SHIP_QUEUE_BASE_REF}"
    names ;;
  gate)
    echo "$SHIP_QUEUE_PR $SHIP_QUEUE_TIP $(git rev-parse HEAD)" >> "\${SHIP_QUEUE_STATE:-/dev/null}/gate-calls"
    names
    if [ -f gate-fail ]; then echo "gate: the browser routine failed"; exit "$(cat gate-fail)"; fi
    echo "gate ok" ;;
  merge)
    names > "$SHIP_QUEUE_STATE/merge-env"
    f="$SHIP_QUEUE_STATE/merge-calls"
    echo "$2 $SHIP_QUEUE_TIP $SHIP_QUEUE_ONTO" >> "$f"
    if [ "$(wc -l < "$f")" -lt 2 ]; then echo "main moved during the gate" | tee "$SHIP_QUEUE_REASON_FILE"; exit 75; fi
    echo "merged $2" ;;
esac
`;

export function testClock() {
  let seconds = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString() };
}

export function makeFixture(options: { readonly declaration?: string } = {}) {
  const tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-steps-")));
  cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
  const remoteDir = NodePath.join(tmp, "remotes", "acme-fixture", "sample-repo.git");
  NodeFS.mkdirSync(remoteDir, { recursive: true });
  sh(remoteDir, ["init", "-q", "--bare", "-b", "main"]);
  const primary = NodePath.join(tmp, "sample-repo");
  sh(tmp, ["clone", "-q", remoteDir, primary]);
  sh(primary, ["config", "user.name", "Fixture Lane"]);
  sh(primary, ["config", "user.email", "lane@example.invalid"]);
  NodeFS.mkdirSync(NodePath.join(primary, "scripts", "ship"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# sample\n");
  NodeFS.writeFileSync(
    NodePath.join(primary, ".tree-guard.conf"),
    `${DECLARATION}${options.declaration ?? ""}`,
  );
  NodeFS.writeFileSync(NodePath.join(primary, "scripts", "ship", "steps.sh"), STEPS_SCRIPT);
  sh(primary, ["add", "-A"]);
  sh(primary, ["commit", "-q", "-m", "init"]);
  sh(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  sh(primary, ["remote", "set-head", "origin", "main"]);

  const prs = new Map<number, { head: string; base: string; title: string; body: string }>();
  const merged: number[] = [];
  const comments: string[] = [];
  const forgeClone = NodePath.join(tmp, "forge-clone");
  sh(tmp, ["clone", "-q", remoteDir, forgeClone]);
  sh(forgeClone, ["config", "user.name", "Fixture Forge"]);
  sh(forgeClone, ["config", "user.email", "forge@example.invalid"]);
  const forge: ShipForge = {
    isPullRequestMerged: async ({ number }) => merged.includes(number),
    findOpenPullRequest: async ({ head }) => {
      for (const [number, pr] of prs)
        if (!merged.includes(number) && pr.head === head) return { number };
      return null;
    },
    createPullRequest: async ({ head, base, title, body }) => {
      const number = prs.size + 1;
      prs.set(number, { head, base, title, body });
      return { number };
    },
    mergePullRequest: async ({ number, title }) => {
      const pr = prs.get(number)!;
      sh(forgeClone, ["fetch", "-q", "origin"]);
      sh(forgeClone, ["checkout", "-q", "-B", pr.base, `origin/${pr.base}`]);
      sh(forgeClone, ["merge", "-q", "--squash", `origin/${pr.head}`]);
      sh(forgeClone, ["commit", "-q", "-m", `${title} (#${number})`]);
      sh(forgeClone, ["push", "-q", "origin", `HEAD:refs/heads/${pr.base}`]);
      merged.push(number);
      return { exitCode: 0, message: `merged #${number}` };
    },
    commentOnPullRequest: async ({ body }) => {
      comments.push(body);
    },
  };

  const reviews: Array<{ ciOutput: string | null }> = [];
  let verdict = "PASS";
  const root = NodePath.join(tmp, "queue");
  const deps: ShipQueueDeps = {
    root,
    run: nodeProcessRunner,
    forge,
    guard: { inspect: () => undefined, check: async () => ({ ok: false }) },
    secretScan: async () => [],
    hygieneScan: async () => ({ kind: "skip", log: "house hygiene: skipped (fixture)" }),
    // Reads CI output where `playbook challenge` reads it: beside SHIP_QUEUE_BODYFILE.
    declarationChallenge: async ({ bodyFile, outFile }) => {
      let ciOutput: string | null = null;
      try {
        ciOutput = NodeFS.readFileSync(
          NodePath.join(NodePath.dirname(bodyFile), "ci-output.txt"),
          "utf8",
        );
      } catch {
        ciOutput = null;
      }
      reviews.push({ ciOutput });
      const report = `PLAYBOOK REVIEW: ${verdict}\nSummary:\n  fixture review\n`;
      NodeFS.writeFileSync(outFile, report, "utf8");
      return { output: `house declaration-challenge: ${verdict}`, report };
    },
    clock: testClock(),
    isProcessAlive,
    self: SELF,
    watcherWaitMs: 60_000,
  };

  const worktree = (branch: string, files: Record<string, string>) => {
    const wt = NodePath.join(tmp, "worktrees", branch.replace(/\//g, "-"));
    sh(primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
    for (const [file, text] of Object.entries(files))
      NodeFS.writeFileSync(NodePath.join(wt, file), text);
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "-q", "-m", `work on ${branch}`]);
    return wt;
  };
  const submit = async (wt: string, branch: string, withDeps: ShipQueueDeps = deps) => {
    const res = await submitJob(withDeps, {
      worktree: wt,
      branch,
      title: `ship ${branch}`,
      body: "Closes #98\n",
      identity: {},
    });
    if (!res.ok) throw new Error(`submit refused: ${res.reason}`);
    registerWatcher(root, res.id, SELF);
    return res.id;
  };
  const markers = (id: string) =>
    readLog(root, id)
      .split("\n")
      .filter((l) => l && !l.startsWith(" "));
  const ciRuns = () => {
    try {
      return NodeFS.readFileSync(
        NodePath.join(root, "repos", "acme-fixture", "sample-repo", "ci-runs"),
        "utf8",
      )
        .trim()
        .split("\n").length;
    } catch {
      return 0;
    }
  };
  const stateFile = (name: string) =>
    NodePath.join(root, "repos", "acme-fixture", "sample-repo", name);
  return {
    tmp,
    root,
    primary,
    stateFile,
    deps,
    prs,
    merged,
    comments,
    reviews,
    setVerdict: (v: string) => {
      verdict = v;
    },
    worktree,
    submit,
    markers,
    ciRuns,
  };
}
