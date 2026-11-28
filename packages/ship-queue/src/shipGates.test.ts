// @effect-diagnostics nodeBuiltinImport:off - Step environments, pre-push CI, and the merge gate over real temporary git repositories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ciOutputPath } from "./ciSteps.ts";
import { readJob, readLog } from "./jobStore.ts";
import { mergeGateOutputPath } from "./mergeGate.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import { fixtureCleanups, makeFixture, sh } from "./testing/shipStepsFixture.ts";
import type { ProcessRunner, ShipQueueDeps } from "./types.ts";
import { runJob } from "./worker.ts";

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
});

/** Worker variables no install, CI, hook, or gate may see. */
const DENIED: Readonly<Record<string, string>> = {
  GH_TOKEN: "gh-worker-token",
  GITHUB_TOKEN: "github-worker-token",
  GH_ENTERPRISE_TOKEN: "ghe-worker-token",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  T3_GUARD_BROKER_SOCKET: "/tmp/t3-broker.sock",
  DOPPLER_TOKEN: "dp.st.worker",
  HOST_GUARD_OVERRIDE: "owner said so",
  AWS_ACCESS_KEY_ID: "AKIAWORKER",
  AWS_SECRET_ACCESS_KEY: "aws-worker-secret",
  CLOUDFLARE_API_TOKEN: "cf-worker-token",
  CARGO_REGISTRY_TOKEN: "cargo-worker-token",
  npm_config__authToken: "npm-worker-token",
  NODE_OPTIONS: "--max-old-space-size=4096",
};

/** Sets worker variables for one test; the returned function puts the old values back. */
function withWorkerEnv(vars: Readonly<Record<string, string>>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Every `env-names:` line in `text`, each as the set of names that step saw. */
function envNameSets(text: string): Array<Set<string>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("env-names: "))
    .map((l) => new Set(l.slice("env-names: ".length).trim().split(/\s+/)));
}

function expectNoDenied(sets: ReadonlyArray<Set<string>>, except: ReadonlyArray<string> = []) {
  expect(sets.length).toBeGreaterThan(0);
  for (const names of sets) {
    for (const denied of Object.keys(DENIED)) {
      if (!except.includes(denied)) expect(names.has(denied), denied).toBe(false);
    }
  }
}

/** Commits `files` onto the fixture's main (the base every job ships onto). */
function addToBase(
  fx: ReturnType<typeof makeFixture>,
  files: Record<string, { readonly text: string; readonly mode?: number }>,
) {
  for (const [file, { text, mode }] of Object.entries(files)) {
    const path = NodePath.join(fx.primary, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text, { mode: mode ?? 0o644 });
    NodeFS.chmodSync(path, mode ?? 0o644);
  }
  sh(fx.primary, ["add", "-A"]);
  sh(fx.primary, ["commit", "-q", "-m", "base: add files"]);
  sh(fx.primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
}

/** A repo's pre-push hook: records git's arguments and stdin, fails on the branch's `prepush-fail`. */
const PRE_PUSH_HOOK = `#!/usr/bin/env bash
{ echo "args: $*"; cat; } >> "\${SHIP_QUEUE_STATE:-/dev/null}/prepush-calls"
echo "env-names: $(compgen -e | sort | tr '\\n' ' ')"
if [ -f prepush-fail ]; then echo "pre-push: lint failed"; exit 1; fi
echo "pre-push: ci-local passed"
`;

const PRE_PUSH_DECL = "ship_ci=pre-push\nship_hooks_path=.githooks\n";

describe("allowlisted step environments", () => {
  it("gives local install, CI, and body steps none of the worker's credentials, and ship_merge only the forge's", async () => {
    const restore = withWorkerEnv({
      ...DENIED,
      FLY_API_TOKEN: "fly-declared",
      CARGO_HOME: "/opt/cargo",
    });
    try {
      const fx = makeFixture({
        declaration: "ship_ci_secret=FLY_API_TOKEN\nship_merge=scripts/ship/steps.sh merge\n",
      });
      const wt = fx.worktree("feat/119-env", { "e.txt": "e\n" });
      const id = await fx.submit(wt, "feat/119-env");

      // The fixture's ship_merge answers 75 once; the second landing merges.
      expect(await runJob(fx.deps, id)).toBe("blocked");
      expect(await runJob(fx.deps, id)).toBe("ended");
      expect(readJob(fx.root, id)?.state).toBe("done");

      const [install, ci] = envNameSets(NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8"));
      expectNoDenied([install!, ci!]);
      expect(ci!.has("FLY_API_TOKEN")).toBe(true);
      expect(install!.has("FLY_API_TOKEN")).toBe(false);
      expect(ci!.has("CARGO_HOME")).toBe(true);
      expect(ci!.has("SHIP_QUEUE_TIP")).toBe(true);

      const body = envNameSets(NodeFS.readFileSync(fx.stateFile("body-env"), "utf8"));
      expectNoDenied(body);
      expect(body[0]!.has("FLY_API_TOKEN")).toBe(false);

      // ship_merge runs `gh pr merge`: it gets the forge's credentials and nothing else denied.
      const merge = envNameSets(NodeFS.readFileSync(fx.stateFile("merge-env"), "utf8"));
      expectNoDenied(merge, ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]);
      expect(merge[0]!.has("GH_TOKEN")).toBe(true);
      expect(merge[0]!.has("FLY_API_TOKEN")).toBe(false);
    } finally {
      restore();
    }
  });

  it("drops the CI host's own credentials from remote steps", async () => {
    const fx = makeFixture();
    const home = NodePath.join(fx.tmp, "ci-home");
    const hostClone = NodePath.join(home, "Dev", "sample-repo");
    NodeFS.mkdirSync(NodePath.dirname(hostClone), { recursive: true });
    sh(fx.tmp, [
      "clone",
      "-q",
      NodePath.join(fx.tmp, "remotes", "acme-fixture", "sample-repo.git"),
      hostClone,
    ]);
    // The CI host's login environment holds credentials of its own.
    const runRemote: RemoteCommandRunner = (_alias, script, options = {}) =>
      nodeProcessRunner({
        command: "bash",
        args: ["-c", script],
        cwd: home,
        env: { ...DENIED, HOME: home, PATH: process.env.PATH ?? "", CARGO_HOME: "/opt/cargo" },
        replaceEnv: true,
        stdin: options.stdin,
      });
    const run: ProcessRunner = (input) =>
      nodeProcessRunner({
        ...input,
        args: input.args.map((a) => a.replace(/^ssh:\/\/ci-1(?=\/)/, "")),
      });
    const deps: ShipQueueDeps = {
      ...fx.deps,
      run,
      runRemote,
      ciPlacer: async () => ({
        kind: "remote",
        host: { name: "ci-1", ssh: "ci-1", role: "ci", data_root: NodePath.join(home, "data") },
        note: "ci host ci-1: room",
      }),
    };
    const wt = fx.worktree("feat/119-remote-env", { "r.txt": "r\n" });
    const id = await fx.submit(wt, "feat/119-remote-env", deps);

    expect(await runJob(deps, id)).toBe("ended");
    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("done");
    expect(job.steps?.map((s) => [s.name, s.host])).toEqual([
      ["ship_body_check", "local"],
      ["ship_install", "ci-1"],
      ["ship_ci", "ci-1"],
    ]);
    const sets = envNameSets(NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8"));
    expect(sets).toHaveLength(2);
    expectNoDenied(sets);
    expect(sets[1]!.has("CARGO_HOME")).toBe(true);
    expect(sets[1]!.has("SHIP_QUEUE_CI")).toBe(true);
  });
});

describe("pre-push CI", () => {
  it("stops the merge when a pre-push repo's hook fails, before any push", async () => {
    const fx = makeFixture({ declaration: PRE_PUSH_DECL });
    addToBase(fx, { ".githooks/pre-push": { text: PRE_PUSH_HOOK, mode: 0o755 } });
    const wt = fx.worktree("feat/119-prepush-red", { "prepush-fail": "1\n" });
    const id = await fx.submit(wt, "feat/119-prepush-red");

    expect(await runJob(fx.deps, id)).toBe("ended");
    const job = readJob(fx.root, id)!;
    expect(job).toMatchObject({ state: "failed", reason: "ci step=pre-push exit=1" });
    expect(job.steps?.map((s) => [s.name, s.host, s.exit])).toEqual([
      ["ship_body_check", "local", 0],
      ["ship_install", "local", 0],
      ["pre-push", "local", 1],
    ]);
    expect(readLog(fx.root, id)).toContain("pre-push: lint failed");
    expect(fx.markers(id).some((l) => l.startsWith("PUSH_EXIT="))).toBe(false);
    expect(fx.prs.size).toBe(0);
    expect(fx.merged).toEqual([]);
  });

  it("merges when the hook passes, handing it git's arguments and ref line under the allowlisted env", async () => {
    const restore = withWorkerEnv(DENIED);
    try {
      const fx = makeFixture({ declaration: PRE_PUSH_DECL });
      addToBase(fx, { ".githooks/pre-push": { text: PRE_PUSH_HOOK, mode: 0o755 } });
      const wt = fx.worktree("feat/119-prepush-green", { "g.txt": "g\n" });
      const id = await fx.submit(wt, "feat/119-prepush-green");

      expect(await runJob(fx.deps, id)).toBe("ended");
      const job = readJob(fx.root, id)!;
      expect(job.state).toBe("done");
      expect(fx.merged).toEqual([1]);
      expect(job.steps?.map((s) => [s.name, s.exit])).toEqual([
        ["ship_body_check", 0],
        ["ship_install", 0],
        ["pre-push", 0],
      ]);
      const ref = "refs/heads/feat/119-prepush-green";
      const remote = NodePath.join(fx.tmp, "remotes", "acme-fixture", "sample-repo.git");
      expect(NodeFS.readFileSync(fx.stateFile("prepush-calls"), "utf8")).toBe(
        `args: origin ${remote}\n${ref} ${job.pushed_sha} ${ref} ${"0".repeat(40)}\n`,
      );
      const output = NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8");
      expect(output).toContain("=== pre-push (host local, exit 0");
      expectNoDenied(envNameSets(output));
    } finally {
      restore();
    }
  });

  it("fails a pre-push repo whose base has no hook instead of pushing unchecked", async () => {
    const fx = makeFixture({ declaration: PRE_PUSH_DECL });
    const wt = fx.worktree("feat/119-nohook", { "n.txt": "n\n" });
    const id = await fx.submit(wt, "feat/119-nohook");

    expect(await runJob(fx.deps, id)).toBe("ended");
    expect(readJob(fx.root, id)?.reason).toBe(
      "ci step=pre-push: the base has no .githooks/pre-push (ship_ci=pre-push)",
    );
    expect(fx.prs.size).toBe(0);
  });

  it("runs the base's hook even when the branch rewrites it", async () => {
    const fx = makeFixture({ declaration: PRE_PUSH_DECL });
    addToBase(fx, { ".githooks/pre-push": { text: PRE_PUSH_HOOK, mode: 0o755 } });
    const wt = fx.worktree("feat/119-hook-swap", {
      "prepush-fail": "1\n",
      ".githooks/pre-push": "#!/usr/bin/env bash\nexit 0\n",
    });
    const id = await fx.submit(wt, "feat/119-hook-swap");

    expect(await runJob(fx.deps, id)).toBe("ended");
    expect(readJob(fx.root, id)).toMatchObject({
      state: "failed",
      reason: "ci step=pre-push exit=1",
    });
    expect(readLog(fx.root, id)).toContain("pre-push: lint failed");
    expect(fx.prs.size).toBe(0);
  });

  it("fails a pre-push repo with no ship_hooks_path, even when the checkout has a hook", async () => {
    const fx = makeFixture({ declaration: "ship_ci=pre-push\n" });
    const hook = NodePath.join(fx.primary, ".git", "hooks", "pre-push");
    NodeFS.mkdirSync(NodePath.dirname(hook), { recursive: true });
    NodeFS.writeFileSync(hook, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const wt = fx.worktree("feat/119-nohookspath", { "p.txt": "p\n" });
    const id = await fx.submit(wt, "feat/119-nohookspath");

    expect(await runJob(fx.deps, id)).toBe("ended");
    expect(readJob(fx.root, id)?.reason).toBe(
      "ci step=pre-push: declare ship_hooks_path so the hook comes from the base (ship_ci=pre-push)",
    );
    expect(fx.prs.size).toBe(0);
  });

  it("does not run a checkout's own hook when ship_ci is a command", async () => {
    const fx = makeFixture();
    const hook = NodePath.join(fx.primary, ".git", "hooks", "pre-push");
    NodeFS.mkdirSync(NodePath.dirname(hook), { recursive: true });
    NodeFS.writeFileSync(hook, "#!/usr/bin/env bash\necho 'local hook ran'\nexit 1\n", {
      mode: 0o755,
    });
    const wt = fx.worktree("feat/119-repohook", { "h.txt": "h\n" });
    const id = await fx.submit(wt, "feat/119-repohook");

    expect(await runJob(fx.deps, id)).toBe("ended");
    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("done");
    expect(job.steps?.map((s) => s.name)).toEqual(["ship_body_check", "ship_install", "ship_ci"]);
    expect(NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8")).not.toContain("local hook ran");
  });
});

describe("ship_merge_gate", () => {
  it("stops the merge when the gate fails, and names a dependency refresh on exit 98", async () => {
    const fx = makeFixture({ declaration: "ship_merge_gate=scripts/ship/steps.sh gate\n" });
    const wt = fx.worktree("feat/119-gate-red", { "gate-fail": "3\n" });
    const id = await fx.submit(wt, "feat/119-gate-red");

    expect(await runJob(fx.deps, id)).toBe("ended");
    const job = readJob(fx.root, id)!;
    expect(job).toMatchObject({ state: "failed", reason: "merge_gate pr=1", pr: 1 });
    expect(job.steps?.at(-1)).toMatchObject({ name: "ship_merge_gate", host: "local", exit: 3 });
    expect(fx.merged).toEqual([]);
    expect(fx.markers(id).some((l) => l.startsWith("MERGE_EXIT="))).toBe(false);
    expect(readLog(fx.root, id)).toContain("gate: the browser routine failed");
    expect(NodeFS.readFileSync(fx.stateFile("gate-calls"), "utf8")).toBe(
      `1 ${job.pushed_sha} ${job.pushed_sha}\n`,
    );

    const wt2 = fx.worktree("feat/119-gate-deps", { "gate-fail": "98\n" });
    const id2 = await fx.submit(wt2, "feat/119-gate-deps");
    expect(await runJob(fx.deps, id2)).toBe("ended");
    expect(readJob(fx.root, id2)?.reason).toBe("dependency_refresh pr=2");
    expect(fx.merged).toEqual([]);
  });

  it("merges after the gate passes on the PR head, keeping its output apart from the CI's", async () => {
    const restore = withWorkerEnv(DENIED);
    try {
      const fx = makeFixture({ declaration: "ship_merge_gate=scripts/ship/steps.sh gate\n" });
      const wt = fx.worktree("feat/119-gate-green", { "ok.txt": "ok\n" });
      const id = await fx.submit(wt, "feat/119-gate-green");

      expect(await runJob(fx.deps, id)).toBe("ended");
      const job = readJob(fx.root, id)!;
      expect(job).toMatchObject({ state: "done", merge_exit: 0, gate_tip: job.pushed_sha });
      expect(fx.merged).toEqual([1]);
      expect(job.steps?.map((s) => s.name)).toEqual([
        "ship_body_check",
        "ship_install",
        "ship_ci",
        "ship_merge_gate",
      ]);
      expect(NodeFS.readFileSync(fx.stateFile("gate-calls"), "utf8")).toBe(
        `1 ${job.pushed_sha} ${job.pushed_sha}\n`,
      );
      const gateOutput = NodeFS.readFileSync(mergeGateOutputPath(fx.root, id), "utf8");
      expect(gateOutput).toContain("gate ok");
      expectNoDenied(envNameSets(gateOutput));
      expect(NodeFS.readFileSync(ciOutputPath(fx.root, id), "utf8")).not.toContain("gate ok");
      const order = fx.markers(id).map((l) => l.split(/[= ]/)[0]);
      expect(order.indexOf("PR")).toBeLessThan(order.lastIndexOf("STEP"));
      expect(order.lastIndexOf("STEP")).toBeLessThan(order.indexOf("MERGE_EXIT"));
    } finally {
      restore();
    }
  });
  it("skips the gate on a merge retry at the same head, and runs it again after a rebase", async () => {
    const decl =
      "ship_merge=scripts/ship/steps.sh merge\nship_merge_gate=scripts/ship/steps.sh gate\n";
    const gateTips = (fx: ReturnType<typeof makeFixture>) =>
      NodeFS.readFileSync(fx.stateFile("gate-calls"), "utf8").trim().split("\n");

    // Same head: ship_merge exits 75 once, the base does not move, so the head the gate passed on lands.
    const same = makeFixture({ declaration: decl });
    const id = await same.submit(
      same.worktree("feat/119-gate-same", { "s.txt": "s\n" }),
      "feat/119-gate-same",
    );
    expect(await runJob(same.deps, id)).toBe("blocked");
    expect(await runJob(same.deps, id)).toBe("ended");
    expect(readJob(same.root, id)).toMatchObject({ state: "done", merge_exit: 0 });
    expect(gateTips(same)).toHaveLength(1);
    expect(readLog(same.root, id)).toContain("already");

    // The base moves: the rebased head is new, so the gate judges it again before the merge.
    const moved = makeFixture({ declaration: decl });
    const id2 = await moved.submit(
      moved.worktree("feat/119-gate-moved", { "m.txt": "m\n" }),
      "feat/119-gate-moved",
    );
    expect(await runJob(moved.deps, id2)).toBe("blocked");
    addToBase(moved, { "other.txt": { text: "other\n" } });
    expect(await runJob(moved.deps, id2)).toBe("ended");
    const job = readJob(moved.root, id2)!;
    expect(job).toMatchObject({ state: "done", merge_exit: 0, gate_tip: job.pushed_sha });
    const tips = gateTips(moved);
    expect(tips).toHaveLength(2);
    expect(tips[0]).not.toBe(tips[1]);
    expect(tips[1]).toBe(`1 ${job.pushed_sha} ${job.pushed_sha}`);
  });
});
